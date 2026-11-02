# Configuration

All settings live in `openblog.json` at the root of your blog. Every key is optional; the
values below are the defaults. `openblog init` writes the file with every key at its
default, so you can edit values in place and delete the ones you do not need.

```jsonc
{
  "title": "open.blog",
  "description": "A blog built with open.blog",   // meta description and feed subtitle
  "url": "https://example.com",                  // the address the site is published at
  "language": "en",
  "author": { "name": "", "url": "", "email": "", "sameAs": [] },
  "contributors": {},                           // reusable people for per-post credits
  "logo": "",                                    // image beside the title, e.g. /images/logo.png
  "favicon": "",
  "ogImage": "",                                 // social card image for pages without a cover
  "theme": "base",                               // default theme (a folder under themes/)
  "colorSchemeToggle": null,                     // null follows theme; true shows button; false uses system preference
  "postPath": "/posts/{slug}/",                  // "/{slug}/" puts posts at the root
  "postsPerPage": 10,                            // 0 shows every post on the home page
  "redirectsFile": false,                        // true also writes a _redirects file: a real 301 for every `aliases:` address (Netlify, Cloudflare Pages)
  "nav": [
    { "label": "Home", "href": "/" },
    { "label": "Series", "href": "/series/" },
    { "label": "Archive", "href": "/archive/" },
    { "label": "Search", "href": "/search/" }
  ],
  "social": [],                                  // footer links, e.g. {"label":"GitHub","href":"..."}
  "footer": "© {year} {author}",
  "poweredBy": true,                             // the "Powered by open.blog" footer link
  "home": { "heading": "Latest posts", "intro": "", "showSeries": true },
  "share": { "enabled": true, "networks": ["x", "bluesky", "linkedin", "reddit", "hackernews", "email"] },
  "analytics": { "builtin": true, "showViews": true, "retentionDays": 400, "endpoint": "", "branch": "analytics", "bakeCounts": true },
  "engagement": { "enabled": false, "comments": true, "analytics": true, "endpoint": "", "feedback": false, "feedbackContact": "", "receipts": false },
  "snippets": { "head": "", "postFooter": "", "bodyEnd": "" },
  "relatedPosts": 3,
  "cdn": { "url": "", "paths": ["/assets/", "/themes/", "/images/"], "version": "", "maxAge": 86400 },
  "feeds": { "rss": true, "json": true, "sitemap": true, "llms": true, "portfolioSnapshot": true, "limit": 20, "fullContent": true },
  "seo": { "aiSearch": true, "aiTraining": true },
  "markdown": { "smartPunctuation": false, "headingAnchors": true, "tocDepth": 3, "tocMinHeadings": 3 },
  "code": { "highlight": null, "lineNumbers": null, "copyButton": true, "playgroundLink": true },
  "codeRunner": { "endpoint": "", "languages": [] },
  "recipes": { "scaling": true, "checklists": true, "timers": true, "cookMode": true, "print": true, "jumpLink": true },
  "knowledgeChecks": { "generationEndpoint": "", "model": "" },
  "paths": { "content": "content", "static": "static", "output": "dist", "themes": "themes", "web": "web" },
  "admin": { "usersFile": ".openblog/users.json", "sessionHours": 12, "secureCookies": false, "maxUploadMb": 10, "trustedProxies": [] },
  "publish": { "remote": "origin", "branch": "main", "auto": false, "includeDrafts": false, "paths": ["content", "static", "openblog.json", "themes", ".github"], "pullFirst": true },
  "knowledgeAtlas": { "publish": false },
  "claimEvidence": { "publish": false },
  "comparisons": { "publish": false },
  "readingPaths": { "publish": false },
  "interpretations": { "publish": false },
  "curatedContext": { "publish": false },
  "readingModes": { "default": "standard" },
  "readerAnnotations": { "enabled": false }
}
```

## Site

- **`colorSchemeToggle`** controls the public light/dark button across all pages.
  `null` (or omitted) follows each page's theme, `true` shows the button and restores
  saved visitor choices, and `false` hides it and follows the system preference,
  ignoring old manual choices. Edit this under **Admin → Appearance**; it does not
  change the Admin's own color scheme. Theme authors can set the inherited
  `options.colorSchemeToggle` default in `theme.json`.
- **`appearance`** is the owner's look: simple presets, never CSS. It is optional, and a site without it
  builds exactly as before. Every value is a choice or a hex color, and a bad value fails the build with
  a plain message:

  ```json
  "appearance": {
    "version": 1,
    "palette": "calm",          // calm, warm, bold, night, garden, paper, ocean, sunset
    "accent": "#2f6690",        // #rgb or #rrggbb; made readable in light and dark if needed
    "fontStyle": "classic-serif", // modern-sans, classic-serif, friendly-rounded, techie-mono
    "textSize": "large",        // small, medium, large, extra-large
    "roundness": "soft",        // square, soft, round
    "spacing": "airy",          // compact, comfortable, airy
    "pageWidth": "wide",        // narrow, medium, wide
    "headingWeight": "bold"     // normal, bold
  }
  ```

  Leave out any field to keep the theme's own value. The engine compiles these into a short block of
  `--ob-*` tokens after the theme's, only for the controls the theme honors (see
  [Look controls](themes.md#look-controls)). Fields it does not know are kept when Admin saves.
- **`url`** is used for canonical links, feeds, the sitemap, and social cards, so set it to
  the real public address. If it includes a path (`https://user.github.io/blog`), the site
  is built to live under that path. See [Deploying](deploy.md).
- **`postPath`** must contain `{slug}`; a value without it is silently replaced by the
  default `/posts/{slug}/`, and a leading and trailing `/` are added if missing. Choose it
  before publishing; changing it later moves every post (add `aliases` to the posts to keep
  old links working).
- **`nav`** entries can point anywhere, including other sites. Pages with `nav: true` in
  their front matter are appended after these.
- **`footer`** replaces `{year}` with the year of the newest post and `{author}` with the
  author name.
- **`author.sameAs`** lists only public profiles that identify the same person (for example,
  a Mastodon, GitHub, or professional profile). It feeds structured author identity; use
  `social` for generic footer links.
- **`contributors`** is a reusable registry for posts with multiple authors or other
  credited people. Keys are lowercase slugs. Each person supports `name`, `url`, `sameAs`,
  and an optional ORCID iD. Profile `url` accepts an HTTP(S) URL or site-root path; every
  `sameAs` entry must be an absolute HTTP(S) URL. Contributor IDs are referenced by post
  credit sidecars, so treat them as stable identifiers. They can also be managed under
  **Site → Contributors** in Admin Studio. See
  [Work-specific credits](content.md#work-specific-credits).
- **Landing page**: when `content/landing.json` exists, the home page is built from its sections instead of
  `home.heading`, `home.intro` and `home.showSeries`. It is written by **Admin → Landing page**; see
  [Landing page sections](content.md#landing-page-sections).
- **`home.intro`** is Markdown shown above the post list on the first page.

## Business facts

`business` states who you are once, and every page, the footer, the Landing page's **Business facts** section
and the `LocalBusiness` structured data read it ([ADR 0305](adr/0305-business-facts-are-one-versioned-block-in-openblog-json-that-pages-the-footer-and-structured-data-all-read.md)).
It is optional: a site without it builds exactly as before. Edit it under **Admin → Settings → Business facts**,
or by hand:

```json
"business": {
  "version": 1,
  "legalName": "Maple Falls Flooring LLC",
  "displayName": "Maple Falls Flooring",
  "trade": "flooring",
  "phone": "+13605550142",
  "email": "office@example.com",
  "hours": {
    "monday":   { "open": "08:00", "close": "17:00" },
    "saturday": { "open": "09:00", "close": "12:30" },
    "sunday":   { "closed": true }
  },
  "licenseNumber": "MAPLEF*123",
  "licenseIssuer": "Washington L&I",
  "insured": true,
  "paymentMethods": ["cash", "check", "credit-card"],
  "foundedYear": 1998
}
```

- **Every field is optional**, and only what you state is shown or published.
- **`phone`** is stored in E.164 (`+`, the country code and digits, 8 to 15 in all) and formatted when a page is
  built: `+13605550142` shows as `(360) 555-0142`, and the link is `tel:+13605550142`. A number written any
  other way fails the build with a message that shows the shape. Admin accepts what you would type
  (`(360) 555-0142`) and stores the E.164 form.
- **`hours`** lists the days you want to state, `monday` to `sunday`. A day is `{ "open", "close" }` in 24-hour
  `HH:MM` (close after open; `24:00` closes at midnight) or `{ "closed": true }`. A day you leave out is not
  stated. Pages group days that share hours ("Mon to Fri 8:00 am to 5:00 pm"). A day cannot run past midnight.
- **`trade`** is one of the job trades (see [Jobs](jobs.md), including your own `extraTrades`). It picks the
  schema.org type: `general-contractor` is `GeneralContractor`, `roofing` `RoofingContractor`, `plumbing`
  `Plumber`, `electrical` `Electrician`, `hvac` `HVACBusiness`, `painting` `HousePainter`, `mobile-mechanic`
  `AutoRepair`, `auto-body-paint` `AutoBodyShop`, `locksmith` `Locksmith`; `excavation`, `flooring` and
  `landscaping` use `HomeAndConstructionBusiness`, and anything else is a plain `LocalBusiness`.
- **`paymentMethods`** is a list from `cash`, `check`, `credit-card`, `debit-card`, `bank-transfer`,
  `mobile-payment` and `financing`. Only the kind of payment is stored, never an account.
- **`licenseNumber`** and **`licenseIssuer`** (the issuer needs the number) and **`insured`** earn the
  "Licensed and insured" badge. `insured` is a claim you make; open.blog does not verify it.
- **`email`** and **`phone`** are business contact details you chose to publish. Nothing about customers is
  stored here.

Where it appears:

- **Footer**: a **Business details** block on every page, styled by the engine's `ob-business` rules with
  `--ob-*` tokens so every theme gets it (see [Theme components](theme-components.md)).
- **Landing page**: the **Business facts** section places the same block (heading of your choice) wherever you
  want it on the home page.
- **Structured data**: the home page carries a `LocalBusiness` (or trade subtype) JSON-LD block with the name,
  legal name, `url`, `telephone`, `email`, `foundingDate`, `openingHoursSpecification` (closed days are left
  out, as schema.org expects), `paymentAccepted` and the license as `hasCredential`. A field you did not state is
  not emitted. No address is emitted (the towns you serve are `serviceAreas`; see [Service areas](service-areas.md)).

The stored object is versioned: a newer version is refused with a message and never rewritten, and fields this
release does not know are kept when Admin saves.

## Share, analytics, related posts, snippets, CDN

These are described in [Sharing, views, analytics, and embeds](features.md).

- `share.networks` accepts `x`, `bluesky`, `mastodon`, `linkedin`, `facebook`, `reddit`,
  `hackernews`, and `email`.
- `analytics.builtin` turns the view counter in `openblog serve` on or off;
  `showViews` controls the count shown on posts. `endpoint` points pages at a counter
  hosted elsewhere, `branch` names the git branch that backs the counts up, and
  `bakeCounts` writes the known counts into static builds. See
  [Publishing from home](publishing.md).
- `engagement.captcha` (optional, off by default, omitted from `openblog.json` until set) protects hosted
  comments with a Cloudflare Turnstile challenge: `provider` is `off` or `turnstile`, `siteKey` is the
  public site key (required for `turnstile`; letters, numbers, `_` and `-`; never a secret) and `scope` is
  `session` (one challenge per tab session, the default) or `every-comment`. The server enforces the same
  scope through `OPENBLOG_CAPTCHA_SCOPE`, so the two must match. Secrets are Netlify environment variables;
  see the [function setup guide](../netlify/functions/README.md#comment-captcha-optional). Readers pass
  the challenge when they first write in the form; locked and hidden discussions never show it.
- `engagement.enabled` adds hosted comments and analytics to static deployments;
  `engagement.endpoint` is the public function URL. Database and moderation secrets stay in server
  environment variables or Admin's write-only private credential store. `engagement.feedback`
  (off by default) lets the hosted function accept typed passage feedback: questions, suggested
  sources and corrections, and other interpretations. It needs its own database table and server
  switch; see the [function setup guide](../netlify/functions/README.md#passage-feedback-optional).
  It is the same as setting those four kinds to `follow-comments` in
  [`participation.kinds`](#reader-participation), where a kind you name takes precedence. With it
  on, each open post gets a "Questions and corrections" form after its navigation (locked and
  hidden posts get none); a post where only some kinds are open offers only those. A reader picks the whole post, a section or words they selected,
  the kind and their note; their name is optional and shown only if they agree. Without
  JavaScript, or when the service cannot take the note, the reader gets instructions or a copy of
  the note to send to the author. `engagement.feedbackContact` (optional) is where that copy can
  go: a plain `mailto:` address or an `https:` contact page, linked from the form. Moderate what
  readers send, with comments, in Admin's **Moderation inbox**; approved notes, with your responses, are kept in
  `content/reader-feedback.json` and shown on the post's page only, and a site with feedback on
  publishes the post's `evidenceRevisions` notes (ADR 0083). `engagement.receipts` (off by
  default, and left out of the file while off) adds "Check, clarify or withdraw a note you sent"
  to the form, where a reader uses the private receipt they were given; switch it on only once the
  hosted function issues receipts (`supabase/protection.sql` and `OPENBLOG_PROTECTION_ENABLED`, see
  [Privacy, retention and deletion](#privacy-retention-and-deletion)). `engagement.evidence` (off by
  default, and left out of the file while off) adds an optional "Evidence" part to suggested sources
  and corrections: the reader picks a published claim, the evidence for it they question, a source
  the post cites or one the site publishes and where in it, and how they say it bears on the
  passage, from lists of what the site publishes, never a private id. Switch it on only once the
  hosted function stores evidence (`supabase/feedback.sql` run again and
  `OPENBLOG_CORRECTIONS_ENABLED`); it also lets you record a correction decision on such a note in
  the **Moderation inbox** (ADR 0118).
- `snippets` are raw HTML placed on every page (`head`, `bodyEnd`) or under every post
  (`postFooter`): third-party analytics, comments, newsletter forms.
- `relatedPosts` is how many related posts to show under each post; `0` hides the section.
- `cdn.url`, when set, serves assets from another origin.

## Feeds

- `rss` writes `/rss.xml`, `json` writes `/feed.json` (JSON Feed 1.1), `sitemap` writes
  `/sitemap.xml` and `/robots.txt`.
- `llms` writes `/llms.txt`, a compact text index, and `/llms-full.txt`, the public article
  text in one retrieval-friendly document. This is an emerging answer-engine convention,
  not a ranking requirement; HTML, feeds, and the sitemap remain authoritative.
- `portfolioSnapshot` writes `/api/blog.json`, a small list of the newest four posts for
  embedding on another site. See [Showing your posts on another site](integrations.md).
- `limit` is the number of posts in the RSS and JSON feeds; `fullContent` includes each
  post's HTML in them (good for readers and cross-posting; set `false` for summaries only).

## SEO and AI crawler policy

- `aiSearch` controls the explicit `robots.txt` groups for OAI-SearchBot,
  Claude-SearchBot, and PerplexityBot. Leave it on if you want those answer products to
  discover and cite the blog.
- `aiTraining` independently controls GPTBot, ClaudeBot, and Google-Extended. Turn it off
  to signal that those providers should not use future crawls for their documented training
  purposes without removing the blog from ordinary search.

These are crawler instructions, not access control. See [SEO and answer discovery](seo.md)
for the publishing checklist and analytics limitations.

## Markdown

- `smartPunctuation` turns straight quotes and dashes into typographic ones.
- `headingAnchors` adds a hover link to each section heading.
- `tocDepth` is the deepest heading level in the table of contents (`2` for `##` only);
  `tocMinHeadings` is how many headings a post needs before it gets one.

## Code blocks

- `highlight` colours code blocks; `lineNumbers` numbers blocks of two or more lines.
  Leave them `null` (or out) to follow the theme, which turns both on by default. Set
  `true` or `false` to decide for the whole blog whatever the theme says.
- `copyButton` adds a Copy button to every code block.
- `playgroundLink` offers an **Open in Rust Playground** link beside runnable Rust examples, in the
  page, in portable copies, and in exports. Set it to `false` to hide the link everywhere; a single
  fence can still choose with `playgroundLink=true` or `playgroundLink=false`. The **Run Rust**
  button is separate and stays.

A post can override `highlight` and `lineNumbers` in its front matter, and one code block
can override line numbers with its fence options (see [Writing content](content.md#code-blocks)).
The order is: the fence, then the post, then this setting, then the theme.

### External code runner

`codeRunner` is optional. With no endpoint, `rust runnable` keeps using the official Rust
Playground and every other configured-runner language stays a static code block. To enable an
independently hosted execution gateway:

```json
"codeRunner": {
  "endpoint": "https://runner.example.com/v1/execute",
  "languages": ["python", "go"]
}
```

The endpoint must be HTTPS without credentials, a query, or a fragment. `languages` is an explicit
allowlist; Rust is routed through the gateway whenever an endpoint is present, and `web` always uses
open.blog's separate browser-preview sandbox. Unknown languages marked `runnable` remain ordinary
static fences. The endpoint is public and appears in generated HTML: never place a token, API key,
or private runner address in it.

See [Deploying an execution gateway](deploy.md#execution-gateway) for the wire contract and runner
isolation requirements.

## Web sandbox

`webSandbox.libraries` names script files that `web runnable` lessons can load with `libs=`.
open.blog bundles no libraries: put the exact builds you want under `static/` (keeping their
license headers) and list them in load order. Paths must be root-relative files your site serves.

```json
"webSandbox": {
  "libraries": {
    "react": ["/vendor/react.production.min.js", "/vendor/react-dom.production.min.js"],
    "angular": ["/vendor/angular.min.js"]
  }
}
```

The page fetches the files from your own site and inlines them into the lesson's preview, so the
preview still makes no network requests and the files need no special headers. Use UMD or other
classic-script builds that define a global, since lessons cannot `import` from the site.
A name can list several files: a framework that compiles components in the browser, such as
Svelte, can ship its compiler and a runtime bundle together, and the lesson compiles its own
component source before mounting it. Every listed file downloads with the page that uses it,
so keep large compilers to the lessons that need them.
See [Writing content](content.md#html-css-and-javascript-sandboxes).

## Recipes

What readers get on posts using `profile: recipe` (legacy `recipe: true` also works; see
[Writing content](content.md#recipes)).
Every option is on by default; set one to `false` to leave that feature out.

- `scaling`: buttons that scale the amount at the start of each ingredient to more or
  fewer servings. Shown only when the recipe has a number in `servings`.
- `checklists`: checkboxes to tick off ingredients and steps, remembered on the reader's device.
- `timers`: durations in steps ("bake for 25 minutes") become countdown buttons.
- `cookMode`: a "Cook mode" button that keeps the screen awake and enlarges the
  ingredients and steps. Browsers that cannot keep the screen awake do not show it.
- `print`: a "Print recipe" button that prints only the title, the summary, the
  ingredients, and the steps.
- `jumpLink`: a "Jump to recipe" link in the summary card.

## Paths

Folder names relative to `openblog.json`. `output` is wiped of stale files on every build,
so point it at a folder of its own. The build refuses an output folder that contains the
blog itself or that it did not create.

## Knowledge checks

Knowledge checks and their local reader interactions need no configuration. Setting
`generationEndpoint` enables optional author-time question generation and review in the admin
editor when a private credential is saved from the Assistant panel or
`OPENBLOG_LESSONS_API_KEY` is present in the server environment. Environment configuration takes
precedence. `model` is an
optional identifier passed through to that endpoint. See [The admin editor](admin.md#optional-question-generation)
for the endpoint contract and security boundary.

## Admin

Settings for the browser editor; see [The admin editor](admin.md).

- `usersFile` holds usernames and password hashes. Keep it out of version control.
- `sessionHours` is how long a login lasts.
- `secureCookies` must be `true` when the editor is served over HTTPS (it should be,
  whenever it is reachable from the internet).
- `maxUploadMb` caps image uploads.
- `trustedProxies` lists the addresses of reverse proxies in front of the server, so login
  limits and the view counter see real client addresses.

## Publish

How the Publish button and `openblog publish` commit and push; see
[Publishing from home](publishing.md). `paths` lists what gets committed, `includeDrafts`
keeps drafts out of public history unless set, `auto` publishes after every save, and
`pullFirst` rebases on changes made elsewhere before pushing.

## Syndication

`syndication.targets` is a map of user-chosen destination names to DEV, Hashnode, Ghost,
WordPress, or manual Medium settings. `stateFile` points to private remote-ID state and
defaults to `.openblog/syndication.json`. Credentials are environment-only and never belong
in this file. See [Cross-posting](cross-posting.md#built-in-command) for setup and the
[automated syndication specification](specs/automated-syndication.md) for the exact fields,
credential names, and safety behavior.

## Knowledge Atlas

`knowledgeAtlas.publish` (off by default) publishes the approved part of your private
Knowledge Atlas: `/atlas/`, a page per approved entry at `/atlas/<id>/`, and the same data as
`/atlas.json`. Only entries you approved, and relationships you approved whose entries are both
approved, are published, each with who asserts it, its evidence, confidence, doubt and any
dissent; private notes, notebook passages and unapproved items never are. Datings you approved
on published items, each cited, are shown on the entry's page with who dates it, the evidence
and your note, competing datings side by side, and on a timeline at the end of `/atlas/` that
reads without JavaScript. An entry with approved relationships also ends with a
[relationship trail](specs/knowledge-atlas.md#relationship-trails): the relationships around it, up
to three steps out, each with its direction, evidence and doubt, and never inferred. While it is
off, no build reads the atlas. Clearing an approval removes the item from the next build. Add
`{ "label": "Atlas", "href": "/atlas/" }` to `nav` to link it from the header. See the
[Knowledge Atlas format](specs/knowledge-atlas.md#publication).

The atlas is private and Git-ignored, so only a build that can read it publishes it:
`openblog serve` and Admin, or a local `openblog build` whose `dist/` you then upload. A CI or
static-host build from the repository finds no atlas and publishes `/atlas/` and `/atlas.json`
empty; `openblog build` and `openblog check` warn when publishing is on but no atlas is stored.
See [Deploying](deploy.md).

## Passage comparisons

`comparisons.publish` (off by default) publishes the passage alignments you approved in Admin's
Compare tool: `/comparisons/`, a page per comparison at `/comparisons/<id>/`, and the same data as
`/comparisons.json`. Every place names its version, editor, translator, scribe or interpreters,
its locators and the rights statement you recorded for that version. Its wording is quoted
exactly only when you state the version's rights as permission, open licence, public domain or
your own work, and only up to 1,000 characters; a version whose rights are unknown or reserved
is identified but never quoted. Your notes on places, rights notes, notebook passage ids and
unapproved alignments are never published, and normalizations only when you choose. Rights
statements are your own declarations, never a legal judgement. While it is off, no build reads
the alignments file; clearing an approval removes the comparison from the next build. Like the
atlas, the alignments file is private and Git-ignored, so only a build that can read it publishes
comparisons, and `build` and `check` warn when it cannot. See the
[passage alignments format](specs/passage-alignments.md#publication).

## Reading paths

`readingPaths.publish` (off by default) is the switch for publishing [reading paths](specs/reading-paths.md),
the ordered routes you curate in Admin under **Content → Reading paths**. While it is off you can write and
preview paths freely; nothing publishes them and `/paths/` is not reserved. Turning it on reserves
`/paths/`, so a page named `paths` or a `postPath` that puts a post there is refused by the build and by
`check`; while it is off, `check` warns when you have path files beside such a page or post.
While it is on, each published path is a page at `/paths/<slug>/` (see [Pages and progress](specs/reading-paths.md#pages-and-progress)); `/paths/` lists the paths you leave `listed`.
Listed paths are also linked from the posts and atlas entries they name, found by site search and listed in `paths.json` ([Discovery](specs/reading-paths.md#discovery)). `openblog paths export` and `openblog paths import <file>` move paths between sites ([Export and import](specs/reading-paths.md#export-and-import)).

## Interpretation comparisons

`interpretations.publish` (off by default) is the switch for publishing the [interpretation comparisons](adr/0232-a-comparison-page-is-static-html-from-the-projection-with-levels-as-sections-a-selector-only-enhances.md)
you write in `content/comparisons` or in Admin under **Content → Comparisons**. While it is off nothing
publishes them and `/interpretations/` is not reserved. Turning it on reserves `/interpretations/`, so a page
named `interpretations` or a `postPath` that puts a post there is refused by the build. Each published
comparison with at least two shown readings is a page at `/interpretations/<slug>/`; `/interpretations/`
lists them. Evidence appears only while `claimEvidence.publish` is on as well, and only for approved links of
approved claims and the sources they cite. A reading attributed to a source that is not published is left out
of the page, and the build warns you by comparison and item id. The files in `content/comparisons` are never
copied as static files.

## Curated research context

`curatedContext.publish` (off by default) turns on the curated-selection projection: Admin's
**What will be public** (and the build's research summary) then lists what your private
`.openblog/private/research/selections.json` would give readers and why anything is withheld.
A selection can only pick what the atlas, comparison and source projections already publish (a
source must already be cited by a published post or published by the atlas or a comparison); it
never approves private research, never copies a note, and lists exactly the fields readers get. It
may be for the whole site or for named posts, in your order. A selection goes stale when what it
selects, or anything it needs, changes, and stays withheld until you check it and select it again.
While the switch is on, a selections file that cannot be read refuses `build` and `check`, naming the
file, and so also blocks publishing a shared reflection (an ordinary post save still succeeds, reporting
the failed build); a selected dating whose competing datings are not selected is a `boundary:` warning. While the
switch is off the file is never read and nothing changes. You choose what readers get from **Selected
for readers** in the Research panel beside a post. The file is private and Git-ignored with the other
research files. See
[ADR 0185](adr/0185-curated-research-context-is-one-more-projection-that-selects-only-what-the-other-projections-publish.md).

What readers get: while `curatedContext.publish` is on and at least one selection publishes, the build
writes `curated-context.json`, a versioned public data file (the published selections with their
attribution, doubt, evidence, provenance and the revision you selected, the context they need, and each
post's items in your order with a canonical anchor for each), and each post you offered something gets a
static **Research context** section after its text, complete without JavaScript. Both are read from the
one public value that Admin's **What will be public** lists, so they never disagree and neither can reach
a private note. With the switch off, or nothing selected, the site builds exactly as before; a file over
its bound is left out whole with a `boundary:` warning and the pages are unaffected. Portable copies, syndicated copies, full-content feeds and `llms-full.txt` carry it too, with a link back to the
canonical section ([ADR 0202](adr/0202-portable-copies-carry-the-public-curated-context-as-labeled-sections-with-links-back-to-the-canonical-page.md)).

The comment you write for a selection is public, so the build's check for private text allows it: any
words it shares with a private note are treated as public everywhere on the site, in every file, not
only in the comment. The rest of that note stays protected, so write a comment fresh instead of pasting
from a note. See the [curated context
format](specs/curated-context.md).

## Reading modes

`readingModes.default` (`standard` by default; `guided` or `deep-dive`) is the mode a post opens in
when it has [supplements](specs/reading-modes.md) and opts in with `readingModes: true` but names no
default of its own. It never opts a post in. The order is the post's own
`readingModes: {default: ...}`, then this site default, then standard, and a reader's saved choice
beats all three. The key is optional and read tolerantly: a bare mode name works, and anything
else is read as standard instead of failing the configuration.

## Reader annotations

`readerAnnotations.enabled` (off by default) gives every post a "Your highlights and notes" region where a
reader can highlight words and keep private notes (see [Reader annotations](specs/reader-annotations.md#highlights-and-notes-on-a-page)).
They are kept in that reader's own browser and are never sent to you, to the build or to any service. Turning
it on adds the region, the post's passage text and one script to each post; with it off, pages are unchanged.
It also adds a second region, "Your reading trails and saved sources", where a reader saves this post or a
reference it cites and builds trails by hand (see [Reading trails and saved sources](specs/reader-annotations.md#reading-trails-and-saved-sources-on-a-page)).
Nothing is recorded as a reader reads, and what they keep stays in their browser.
The same panel lets a reader export that data to a file, import one after a preview, turn the feature off in their
browser, and erase it (see [Export, import and privacy controls](specs/reader-annotations.md#export-import-and-privacy-controls)).

## Claim evidence

`claimEvidence.publish` (off by default) publishes the claims and evidence links you approved in
Evidence Studio with the posts they are about: each such post gains a "Claims and evidence"
section listing, for every approved claim, its supporting and contradicting evidence side by side
with the references, locations, your rationale, confidence and uncertainty, and the site gains
`/claim-evidence.json` with the same data. Support is never published while a contradicting link
on the same claim is private, and nothing is netted or scored. Revision notes you write in a
post's front matter as `evidenceRevisions` are published in the same section. While it is off, no
build reads the private claims file and every post is unchanged, except that a site with
`engagement.feedback` on still publishes revision notes (ADR 0083). Clearing an approval removes the
item from the next build. See the [claims format](specs/claims-evidence.md#publication).

The claims file is private and Git-ignored, so only a build that can read it publishes claim
evidence: `openblog serve` and Admin, or a local `openblog build` whose `dist/` you then upload. A
CI or static-host build publishes no claims (revision notes still appear), and `openblog build`
and `openblog check` warn. See [Deploying](deploy.md).

## Reader participation

Hosted comments keep their switches: `engagement.comments` and each post's `comments:`. Every
other way to take part is a participation kind, off until you switch it on in `participation`
(omitted while it has its defaults):

```jsonc
"participation": {
  "kinds": { "question": "hidden", "third-perspective": "open", "abuse-report": "open" },
  // Optional. Leave it out to keep comments as they are; see below.
  "retention": { "pendingDays": 90, "clarificationDays": 30, "closedDays": 30, "auditDays": 365 }
}
```

- `kinds` takes `question`, `source-suggestion`, `correction-suggestion`,
  `alternative-interpretation`, `third-perspective`, `author-response`, `abuse-report` and
  `future-suggestion` (readers' questions and sources for future work, private to the editors;
  [ADR 0152](adr/0152-a-future-suggestion-is-one-more-participation-kind-whose-approval-publishes-nothing.md)). Each is
  `off` (the default: front matter cannot turn it on), `hidden`, `locked` or `open` (switched on,
  and the mode of posts that do not name it), or `follow-comments` (each post's mode is its
  `comments:` setting). `abuse-report` is `off` or `open` for the whole site. A post chooses its
  own mode with [`participation:`](content.md) front matter.
- Everything submitted starts pending, and only what a moderator approves is shown. Nothing is
  ever e-mailed to readers. Nothing is accepted without hosted engagement and an endpoint.
- `retention` (days, 1 to 3650): unmoderated items expire after `pendingDays`, unanswered
  clarification requests after `clarificationDays`, the text of rejected and removed items and of
  upheld abuse reports is purged after `closedDays` (an accepted suggestion for future work is kept,
  but its private contact and unshown name are cleared after `closedDays`), and the private
  moderation record after `auditDays`, which must be
  at least `closedDays`. Without `retention` these defaults apply to every kind except comments:
  hosted comments are kept as they always were, never expired or purged. Writing `retention`
  yourself, even as `"retention": {}` for the defaults, applies it to comments too.
- Once a kind beyond comments is switched on, builds also write `openblog-participation.json`,
  the public map of each post's open and locked kinds that the hosted function checks.
- `future-suggestion` adds a "Suggest something for future work" region to each post where it is
  `open`: a reader writes a question or suggests a text, video, audio or other source in their own
  words, with an optional public link, source details, the article it is about, a name they may be
  thanked by and an address they agree to be contacted at. It goes to the editors' private queue and
  never to a page; accepting one means only that the editors are interested. With hosted engagement
  the form sends through the function only when `engagement.receipts` is on and the function takes
  suggestions (`OPENBLOG_SUGGESTIONS_ENABLED`, see [the function's guide](../netlify/functions/README.md#suggestions-for-future-work-optional));
  otherwise, and whenever the service cannot take it, the reader gets the suggestion to copy and
  send to `engagement.feedbackContact`. A site with no hosted service shows only that contact (and
  nothing when none is set). Editors read, decide and, for an accepted one, copy it into a private
  research note in the **Moderation inbox**; its contact and unshown name are cleared after
  `retention.closedDays`
  ([ADRs 0158](adr/0158-suggestions-are-sent-through-the-one-feedback-route-behind-their-own-opt-in-with-the-page-as-work.md)
  to [0160](adr/0160-editors-read-suggestions-in-the-one-inbox-and-copying-one-into-a-research-note-is-an-explicit-unverified-export.md)).
- `third-perspective` adds an "Offer a Third Perspective" region to each post where it is `open`:
  a reader writes their own reflection on the whole work or one section, may choose a prompt
  (never a score or a vote), and decides whether it may be published, whether their name may be
  shown and whether they may be asked to clarify it. The form sends through the hosted function
  only when `engagement.receipts` is on and the function takes Third Perspectives
  (`OPENBLOG_THIRD_PERSPECTIVES_ENABLED`, see [the function's guide](../netlify/functions/README.md));
  otherwise, and whenever the service cannot take it, the reader gets their reflection to copy and
  send to `engagement.feedbackContact`. Moderators approve exactly the text and the consent they
  saw in the **Moderation inbox** (ADRs [0113](adr/0113-third-perspectives-are-one-feedback-row-submitted-through-the-one-route-with-a-receipt.md)
  and [0114](adr/0114-the-third-perspective-form-is-one-progressive-region-with-explicit-consent.md)).
  Approving one writes its public part to `content/third-perspectives.json`, versioned with the
  site; posts where the kind is `open` or `locked` show those reflections in a "Third
  Perspectives" section, even without a hosted service, and portable copies, feeds and
  `llms-full.txt` link there instead of carrying them
  ([ADR 0115](adr/0115-approved-third-perspectives-publish-from-a-versioned-public-file-and-portable-copies-link-to-them.md)).
  A file that cannot be read stops `build` and `check`, as `reader-feedback.json` does.
  A reader who withdraws a reflection deletes the hosted copy of its text and name; the Moderation
  inbox then shows, on every tab, that it must come off its post, and the site Admin takes it
  off. Copies already published (the site's history, feeds and the repository's history) may
  remain, which is what the form and the withdrawal say to readers, and a name a reader chose to
  show becomes part of the site's public record. To roll the hosted opt-in back, empty
  `content/third-perspectives.json` (or hide the kind) first.
- `author-response` lets the author of one section of a shared reflection answer a Third Perspective
  about it. Where it is `open` on a post whose body is an arranged shared reflection with a committed
  credits sidecar, the "Offer a Third Perspective" form also offers "One author's section", chosen by
  author and place (never a side of the page). In Admin, only the contributor bound to that section
  sees "Answer as ...", on a reflection that is shown, and the answer waits for a coordinator in the
  **Moderation inbox**: it is never approved by the account that wrote it, only under a reflection
  that is shown now and about that very author's section, and its author can take it back. The
  hosted function needs `OPENBLOG_AUTHOR_RESPONSES_ENABLED=true` on top of Third Perspectives and no
  SQL ([the function's guide](../netlify/functions/README.md#author-responses-optional-no-sql); ADRs
  [0131](adr/0131-a-reader-writes-about-one-authors-section-from-the-builds-own-list-by-author-and-place.md)
  to [0135](adr/0135-until-sections-have-anchors-an-approved-reflection-about-an-authors-section-is-named-by-its-author-and-never-linked.md)).
  Where the kind is not `hidden`, an approved answer is published, with its reader's reflection, in
  `content/third-perspectives.json` and shown on the post after that author's own section, labelled
  as the author's response (ADRs
  [0137](adr/0137-an-approved-author-response-is-published-under-its-reflection-in-the-one-public-file-and-shown-only-where-the-one-rule-says-so.md)
  to [0139](adr/0139-portable-copies-and-feeds-link-to-a-conversation-and-never-copy-it.md)); `locked`
  keeps showing what was approved and takes nothing new, and a post that leaves the kind `hidden` or
  `off` is built exactly as before. Portable copies, feeds and `llms` files only link to the
  canonical post.

The rules are recorded in ADRs [0101](adr/0101-one-registry-of-participation-kinds-enabled-per-site-and-post.md)
to [0104](adr/0104-retention-audit-events-and-abuse-reports-fail-closed.md).

### Privacy, retention and deletion

What the hosted service keeps, and how it goes, once you run the optional
[engagement protection](../netlify/functions/README.md#engagement-protection-optional) schema
(ADRs [0107](adr/0107-reader-receipts-deletion-requests-and-anonymous-abuse-reports.md) and
[0108](adr/0108-retention-runs-from-a-dry-run-and-quotas-keep-only-hourly-digests.md)):

- **Never stored:** a reader's IP address, user agent, e-mail address or any identifier that
  lasts beyond an hour. Rate limits keep a salted digest of the client for the hour only; page
  analytics keep a daily digest that changes every day. Service credentials stay in Netlify and
  never reach Admin's browser or a page.
- **Receipts:** a reader who sends passage feedback gets a private receipt once; only its digest
  is stored. With it they can check on the note, agree to be asked to clarify it, answer a
  clarification request, or withdraw it. Nothing is ever e-mailed.
- **Withdrawal and deletion:** withdrawing by receipt deletes the note's text, details and the
  reader's name at once and keeps only its state and a record of decisions without text. If the
  note was published, the inbox tells you to take it off the post. For a reader who asks you some
  other way (a commenter, say), first reject or remove the item, then use **Delete its text and
  name** on it in the inbox.
- **Abuse reports:** anonymous, never published or counted, and taken only for an item that is
  public now. Upholding one removes the item in the same decision, or changes only the report if
  the item is already out of view.
- **Retention:** nothing is deleted on a schedule. In **Moderation inbox → Retention**, check what
  retention would do under the periods above, then run it. Pending items expire, the text of
  closed items and upheld reports is purged after `closedDays`, withdrawn text at once, and
  records of decisions after `auditDays`. Comments are included only if you set `retention`
  yourself.

## Themes

Themes are not configured here beyond `theme`; each theme has its own `theme.json`. See
[Themes](themes.md).
