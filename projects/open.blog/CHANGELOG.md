# Changelog

All notable changes to open.blog are recorded here. Releases follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.52.0] - 2026-10-29

- A provider that refuses an account's sign-in while posting (a 401, or Facebook's expired-token codes) now moves that account to **Needs reconnecting** (story #358; ADR 0319), so its other announcements fail before being sent instead of each being tried with a dead token.
- Publishing adapter tests (story #358; ADR 0321): one fixture of LinkedIn and Facebook replies (success, 401, 403, 429, 5xx, a redirect, network failure, refused connection, timeout, ambiguous success) is run through both adapters against the worker's delivery contract, and the real delivery worker is run with the real adapters over a scripted provider, from the reply to the stored announcement. Unconfigured and unsupported networks get no adapter, and no token or provider text can reach a stored error, a summary or a log. See [Social publishing](docs/social-publishing.md#how-the-adapters-are-tested).
- Facebook publishing adapter (story #358; ADR 0320): when Facebook is configured, the delivery worker posts an announcement's caption and link to the connected Page's feed with that Page's token (sent in a header, never in the address) and keeps the returned post id. Facebook's own error codes decide what happens: an expired token needs reconnecting, a permission or role problem is final, a rate limit (including Meta's Page-level limit, code 80001) pauses the Page and is retried later, and an "unknown error" is an unclear outcome. An unclear outcome is looked up, read only, among the Page's own posts made during the attempt, and settled only when exactly one has both the announcement's caption and its link; a hand-made share of the link or another announcement of the same post comes to you as **Needs checking** instead. See [Social publishing](docs/social-publishing.md#facebook-pages).
- LinkedIn publishing adapter (story #358; ADR 0319): when LinkedIn is configured, the delivery worker posts an announcement to the connected member or organization through the versioned Posts API as an article link and keeps the returned post URN. Both adapters implement the worker's delivery contract: a success needs the provider's post id; a refused sign-in or a refusal is final; a rate limit waits for the provider's `Retry-After`; only a request that certainly never left is retried; a success without an id, a server error or a timeout may have posted and is never sent again. LinkedIn offers no lookup to this app, so its unclear outcomes come straight to you. Neither provider accepts an idempotency key, so none is sent. No provider is used until you configure it. See [Social publishing](docs/social-publishing.md#publishing-adapters).
- Social publishing retries, rate limits and uncertain outcomes (story #357, task #372; ADR 0318): a delivery that certainly did not post is retried with exponential back-off (at most 5 tries by default), a provider's 429 and `Retry-After` pause that account, and a refusal is final. A delivery that may have posted (a timeout, a dropped connection, a 5xx, a crash, a success that could not be recorded) becomes **Needs checking** and is never sent again by itself: the worker looks it up through the provider adapter, and if it cannot tell, you say in Admin whether it was posted (with the post id) or not. A failed announcement shows why in plain words and **Try again** (after a confirmation) puts it back in the queue; each announcement lists **What was tried**. New hosted and Admin routes: `announcements/retry`, `announcements/resolve`, `announcements/attempts`. No provider text, token or key is ever stored or shown.
- Social publishing delivery worker (story #357, task #371; ADR 0317): an optional hosted function, `POST /api/social-worker`, claims a bounded batch of due announcements, delivers each through its provider's adapter and records the outcome, answering with counts only. Only the worker key can call it (the admin key, a public key and the service key cannot); it is a 404 unless social publishing is configured. `supabase/social-cron.sql` (with a rollback) schedules it every minute with pg_cron and pg_net, reading the address and key from Supabase Vault. The worker calls providers only through a narrow adapter interface and is tested with a fake one; an announcement for a provider with no adapter yet waits instead of failing. Batch size, lease, timeout and run budget are optional bounded settings.
- Social publishing delivery queue (story #357, task #370; ADR 0316): an optional `supabase/social-queue.sql` (with `social-queue-rollback.sql`) adds the functions a delivery worker uses to claim due announcements atomically (`for update skip locked`, a bounded batch, a lease, an attempt counter and an attempt row in one step), to mark the moment before a provider call, and to record an outcome fenced by version. A lease that runs out before the provider was called returns the announcement to the queue; one that runs out after is `unknown` and is never sent again. Additive, private to `service_role`, and off unless you run it; tested against a real Postgres with two concurrent claimers.
- Service-area pages (epic #473, story #484; ADR 0315): a site that lists `serviceAreas` gets `/areas/` and one page per town with your services, the newest jobs whose `place.town` and `place.region` match (title, link and date only; never an address), and your business facts block. A town with no posted jobs says so plainly instead of filler. Pages carry `areaServed` structured data (and the home page's `LocalBusiness` lists every area when business facts are set), join `sitemap.xml` and `llms.txt`, and add an "Areas" navigation link. A site without `serviceAreas` builds byte-for-byte as before. See [Service areas](docs/service-areas.md).

- Service areas configuration (epic #473, story #484; ADR 0314): an optional versioned `serviceAreas` list in `openblog.json` of towns (town, region, optional one-line note). A town is checked like a job's place (no street address or postal code), a region is formatted from a bundled list of US states and Canadian provinces, the same town and region twice is refused (ignoring case), the list holds at most 100 areas, and every problem is a plain sentence naming the entry. A site without it builds byte-for-byte as before. See [Service areas](docs/service-areas.md).
- Hosted comment captcha (epic #296; ADR 0322): optional Cloudflare Turnstile verification before the first comment of a visit. `engagement.captcha` (`provider` off or turnstile, public `siteKey`, `scope` session or every-comment) is the only thing stored; the server is switched on separately with `OPENBLOG_CAPTCHA_PROVIDER` and holds `OPENBLOG_TURNSTILE_SECRET` and `OPENBLOG_CAPTCHA_SESSION_SECRET` (optional `OPENBLOG_CAPTCHA_SCOPE` and `OPENBLOG_CAPTCHA_SESSION_TTL_SECONDS`). An unverified comment gets `403 captcha_required` before anything is stored; a passed challenge is exchanged for a stateless signed 30-minute pass kept in `sessionStorage`; failed attempts use their own quota bucket with no SQL migration; a misconfigured server answers `503` naming the variable. The challenge script loads only when the reader starts writing, with a one-line disclosure, announced states, a Retry button and the typed text always kept. Admin → Analytics gets a captcha section with read-only variable guidance and no secret field. Sites that do not enable it are unchanged. See the [setup guide](netlify/functions/README.md#comment-captcha-optional).

- Edit services in Admin and scaffold them from the CLI (epic #473, story #483; ADR 0313): **Services** (`#/services`, under the Content tabs and in the command palette) lists your services and edits one with a name, id, summary, a list of what is included, a price band, a timeline, a list of questions and answers (add, move up, move down, remove) and the page text, in one column from 320px with 44px controls and problems said beside the field. It uses the existing document routes (`kind=services`), so sessions, CSRF, size bounds, revision checks and the trash are the ones posts, pages and series already have. `draft: true` keeps a half-written service off the site; the job form suggests your published service ids. `openblog new "Name" --profile service [--id <id>] [--price-band <band>]` writes a draft `content/services/<id>.md`. The durable workspace allow-list gains `services/`.

- Service pages and structured data (epic #473, story #483; ADR 0312): a site with services gets a `/services/` index and one page per service (what is included, the price band as words with a "guide, not a quote" note, the timeline, the questions and answers, and the newest jobs done for it), `Service` JSON-LD with `FAQPage` beside it only when there are questions, sitemap and `llms.txt` entries and a "Services" navigation link. The same files always build the same pages. A site with no services builds byte-for-byte as before.

- Services collection (epic #473, story #483; ADR 0311): an optional `content/services/` folder of Markdown files, one per service, with a versioned front matter (`id`, `name`, `summary`, `includes`, `priceBand`, `typicalTimeline` and a `faq` list of questions and answers) and a body. The price band is the same set a job's `costBand` uses and is only a label. Ids must be unique, and once a site has a service, a job whose `job.service` is not one of them fails the build with the known ids listed (a draft job warns). Sites without the folder, and their jobs, behave exactly as before, and so does a legacy Markdown file in `content/services/` whose front matter declares neither `version` nor `id`: it is not a service and is ignored, while one that declares either and is invalid fails the build. See [Services](docs/services.md).
- Social publishing screen (story #356; ADR 0310): when social publishing is set up, Admin shows an **Announcements** tab (`#/announcements`) with a composer (destination, published post, caption with a live count, date and time in your own zone, and a preview built from the same rules as the schedule) and the list of announcements with edit and cancel. Problems are listed and shown beside their fields, a skipped or repeated clock time on a clock-change day is explained, a double click schedules once, cancel asks first, and a worker's claim while you look refreshes the list and says so. It is keyboard-operable, labelled, one column on a phone, and shows no key or token. Without the settings there is no tab. See [Admin](docs/admin.md#announce-a-post-on-social-media-optional).
- Social publishing scheduling API (story #356; ADR 0309): Admin gains `/admin/api/social/*` (list posts and destinations, preview, create, list, edit, reschedule and cancel announcements) served by the same hosted `social` function as connected accounts. Admin checks the session and CSRF token and that the post is public, builds the link from your site (never from the browser), then calls the hosted function with the admin key, which stays in Admin's environment (`OPENBLOG_SOCIAL_ENDPOINT`, `OPENBLOG_SOCIAL_ADMIN_KEY`, the same settings as connected accounts). Creating is idempotent; edits and cancels name the version and succeed only while the announcement is still scheduled, so a worker's claim and an author's change cannot both win. Off and invisible unless configured.
- Social publishing announcements, model (story #356; ADR 0308): an announcement links an already-public post of your own site at a UTC time. Only a published post with a public `https` address can be announced (not a draft, a future-dated post or a cross-post whose canonical address is elsewhere); the caption is bounded per destination and refuses control and direction-changing characters; the time must name its zone and lie between a minute and a year ahead; only a scheduled announcement no worker has claimed can be changed or canceled. The Rust Admin and the hosted function share one fixture of accepted and refused values.

- Business facts screen in Admin (epic #473, story #482; ADR 0307): **Business facts** (`#/business`, under the Content tabs and in the command palette) edits the `business` block without touching JSON. Type a phone number the way you say it and it is saved with its country code; each weekday has its own choice (not shown, open with times, open 24 hours, closed) with a copy-Monday shortcut; problems are said in plain words beside the field. It is one column from 320px with 44px controls. A save is checked against the revision of the block alone and changes only the `business` key of `openblog.json`: every other key keeps its place (the file is edited as text, not rewritten from a sorted copy). New routes: `GET`/`PUT /admin/api/business`.

- Business facts on every page (epic #473, story #482; ADR 0306): when `business` is set, every page's footer carries one block with the name, a "Licensed and insured" badge, phone and email links, hours grouped by day, the license, accepted payments and the year founded, styled by the engine with `--ob-*` tokens so every theme gets it. The home page also carries `LocalBusiness` structured data (a trade subtype such as `Plumber` or `RoofingContractor` where schema.org has one) with only the fields you stated. The Landing page builder gains a **Business facts** section; a page that uses it is stored as landing version 2, every other page is unchanged. Sites without `business` build exactly as before.

- Business facts in `openblog.json` (epic #473, story #482; ADR 0305): an optional, versioned `business` block states the legal and display name, trade, phone (stored as E.164 and formatted when pages are built), email, opening hours per weekday with closed days, license number and issuer, an insured flag, accepted kinds of payment and the founding year. A bad phone, time or payment method fails with a plain message naming the field. Without the block nothing changes. See [Configuration](docs/configuration.md#business-facts).

- A trades voice prompt pack (epic #472, story #481): the bundled voice catalog gains a `trades` pack of eight short prompts for people who work with their hands (a job that went sideways, the question every customer asks, the tool you would never give up, and more), each answerable in three minutes. Hide it like any pack with `disabled: [trades]` in `assistant/voice/catalog.md`.

- Draft with AI in Capture (epic #472, story #480; ADR 0304): with a configured Assistant provider and some notes (typed, or a transcript), **Draft with AI** first shows where the notes go and what goes with them, with a tick to write it in your voice by sending your voice guide, and sends nothing until you tap **Send to the Assistant**. The result fills an editable Title, Description and the four job sections as unsaved changes, with one **Undo the draft**; it replaces the notes in the saved post only when you tap **Save draft**, and never saves or publishes by itself. Without a provider your typed notes become the post as before. A waiting capture keeps an applied draft in its queue record (an optional `fields.draft`, version 1).

- Job drafts (epic #472, story #480; ADR 0303): a new Assistant task, `job-draft`, turns a job's notes into a title, a description and the four scaffold sections, in your voice when your voice guide is selected (read again on the server from its id). `POST /admin/api/assistant/job-draft` returns a proposal under a strict schema that has no place for any `job` field; a result with another field, HTML, a fence, a heading, front matter, an over-long field or no content at all is refused whole with a plain reason, and nothing is applied. The engine guide now teaches job drafts (version 6).
- Transcribe a voice note (epic #472, story #480; ADR 0302): under a finished note, **Transcribe with AI** shows where the recording would go and what is sent (the recording only, nothing else) and sends it only when you tap **Send the recording**. `POST /admin/api/assistant/transcribe` runs through the Assistant provider boundary (OpenAI or Gemini; every other provider is never sent audio) or a local engine named in `OPENBLOG_TRANSCRIBE_COMMAND`, with the usual session, CSRF, concurrency, timeout and safe-error rules. The transcript is untrusted text: it is kept privately beside the note, cleaned and bounded, and added to Notes made plain, with one-step **Undo the transcript**. With no provider you type your notes and nothing else changes.
- Connected accounts in Admin (story #355; ADR 0301): a **Social accounts** page (`#/social`, shown in the navigation only when `OPENBLOG_SOCIAL_ENDPOINT` and `OPENBLOG_SOCIAL_ADMIN_KEY` are set for the Admin process) connects LinkedIn and Facebook with the permissions reviewed first, offers only destinations the provider confirmed, reconnects an account whose access ran out, and disconnects after a confirmation. It works by keyboard, at 320 px and with a screen reader; the Admin server rebuilds every reply from known fields, so no token or key ever reaches the browser. Off and invisible by default. See [Social publishing](docs/social-publishing.md#connected-accounts-in-admin).

- Social publishing destinations (story #355; ADR 0300): after authorizing, the hosted function lists where the grant can really post (a LinkedIn member and, with approval, organizations; Facebook Pages the person can create content on) and offers only what the provider confirms, with the reason for the rest and a plain note when something cannot be verified, such as Meta App Review. The author chooses once; reconnecting works only for the same identity; disconnecting erases the stored tokens and asks LinkedIn to revoke when nothing else shares the grant. Tokens are never returned.

- Social publishing OAuth (story #355; ADR 0299): the hosted function can start and finish a LinkedIn or Facebook OAuth authorization-code handshake with a single-use state, optional PKCE, exact registered redirects, scopes verified from the provider's grant, and tokens sealed until the author picks a destination. Providers, API versions and scopes are settings; `supabase/social.sql` gains one additive table. Off unless social publishing is enabled and a provider is configured. See [Social publishing](docs/social-publishing.md).

- Capture a job from a phone (epic #472, story #479; ADR 0296): a **Capture** view in Admin (`#/capture`), built at 400 px, takes photos (camera or library), the trade, service and town (remembered on the device, with your recent towns one tap away) and a few lines of notes, and saves one unpublished job draft with the Job form's keys, the job headings, the notes and the photos attached through the existing upload. No provider is contacted. A capture is bounded: twelve photos, 8,000 characters of notes, and each photo within `admin.maxUploadMb`. See [Capturing a job from a phone](docs/jobs.md#capturing-a-job-from-a-phone).

- Offline capture (story #479; ADR 0297): a capture is kept on the phone in a bounded, versioned IndexedDB queue (five captures, 60 MB each, 120 MB in all) and sent when the connection returns, on opening Capture or on **Send now**, oldest first. Every capture carries a random id, and the server saves the draft and each photo at most once per id (photos at a fixed name under `images/uploads/captures/`, the draft through a private ledger in `.openblog/captures/`), so replaying a capture never makes a second draft. A newer stored version is kept untouched, a capture the server refuses is marked and can be retried or discarded, and a browser without IndexedDB sends straight away.

- Voice notes in Capture (story #479; ADR 0298): where the browser has a recorder, **Record a voice note** starts only on a tap (a script cannot open the microphone), stops at three minutes or 8 MB, and has a clear **Stop recording** and **Discard**. A finished note travels with the capture and is kept privately in `.openblog/captures/` by capture id, checked by its bytes, never in the post or any published or exported file. Nothing is transcribed or sent to a provider. Without a recorder, or with the microphone blocked, the view says so and typing still works.
- Social publishing credentials (story #354; ADR 0295): provider tokens are envelope-encrypted by the hosted function (AES-256-GCM, a per-connection data key wrapped by `OPENBLOG_SOCIAL_TOKEN_KEYS`, which is never in the database), refreshed once at a time shortly before expiry, erased on revoke or when the provider drops the grant, and never shown in Admin, errors or logs. `OPENBLOG_SOCIAL_TOKEN_KEYS` is now required to enable social publishing.

- Social publishing schema (story #354; ADR 0294): `supabase/social.sql` adds private, site-keyed tables for connected accounts, the schedule queue and delivery attempts, shaped for atomic claim, idempotency keys and provider response ids, with `supabase/social-rollback.sql`. It is optional, additive and re-runnable, and nothing reads it unless social publishing is enabled.

- Optional social publishing, identity boundary (epic #353, story #354; ADR 0293): scheduled social publishing is off unless a deployer enables it. The Rust Admin authorizes the author and the hosted function acts for one server-configured site with separate admin and worker keys; a request can never name a site. Site builds, portable exports and cross-posting are unchanged without it. See [Social publishing](docs/social-publishing.md).


- Before and after (epic #471, story #478; ADR 0291): a `compare` fence pairs two photos in any post, with a required description for each side, optional captions and labels ("Before" and "After" by default). A missing description or an unknown field is refused with a plain message. It is reported as the `before-after` capability. On the page it is an `ob-compare` control (a range with arrow keys, Home and End, touch drag, a labelled handle and a visible focus ring) that every bundled theme styles through documented `--ob-compare-*` tokens; without JavaScript or with reduced motion the two pictures sit side by side. Feeds, syndicated copies and portable export get two captioned figures and nothing else, and the pictures use the existing lazy loading. Sites that never write the fence build byte for byte as before. Admin's **Add something** has a Before and after entry in both editor modes: two pictures (typed or chosen), a description of each, optional captions and labels, and the engine's refusals shown inside the dialog (ADR 0292). See [Content](docs/content.md#before-and-after).
## [0.51.0] - 2026-10-29

- Jobs (epic #471, story #476; ADR 0285): a new `job` content profile records one piece of finished trade work as an ordinary post, with a `job` front matter mapping for trade, service, town, dates, materials, a cost band and before and after images. Fields are checked with plain messages that name the field, `costBand` is an enum, a place is a town and never an address, and unknown keys are kept. Sites add their own trades with `extraTrades` in `openblog.json`, and a site with jobs gets `/jobs/`, `/jobs/<trade>/` and `/jobs/<trade>/<service>/` archives (paged like the home page, in the sitemap, none when empty; ADR 0286). A site that does not use the profile builds byte for byte as before. See [Jobs](docs/jobs.md).

- Job mode in Admin (story #477; ADR 0287): choosing the Job content profile in a post's Settings shows an **About this job** form for trade, service, town, region, dates, price range and before and after photos, writes the `job` mapping, and gives an empty body the headings `Problem`, `What we found`, `What we did` and `Result` as ordinary Markdown. Switching profile never changes the body, and **Check this job** lists what a build would still need. It works at 400 px. `openblog new "Title" --profile job` (with optional `--trade`, `--service`, `--town`, `--region`) writes the same front matter and headings as a draft, and an unknown trade is refused with the bundled and site-level trades listed.

- Voice samples (epic #410, with epics #406 to #409; ADRs 0266 to 0284 and 0288 to 0290; specification in [docs/specs/voice-samples.md](docs/specs/voice-samples.md)): write short answers to prompts as samples of how you sound, keep them as Assistant context, and let the Assistant learn from them only when you choose. They are never published, built, fed or exported as content, and a project without samples builds and runs exactly as before. See [Where voice samples are kept](docs/admin.md#where-voice-samples-are-kept).
  - Samples are plain Markdown in `assistant/context/voice/` (portable) or `.openblog/private/context/voice/` (private, the default). A rough draft is immutable once its session ends: the store refuses any later write, while a polished draft is yours to edit with a revision check. A bundled catalog of ten genre packs and forty-two prompts can be extended or trimmed per site with `assistant/voice/catalog.md`; drawing three prompts is seeded and spreads across packs. The Assistant Context view names a private voice sample that Git tracks.
  - From the command line, `openblog voice` draws three prompts (or takes a prompt id), lets you write in `$EDITOR` or the terminal against a three-minute clock, and locks the rough draft exactly as written; `--resume` carries on with the original deadline, `--list` shows packs, your answered prompts and gaps, `polish` edits a copy as a polished draft, `diff` shows the change, and `promote` creates a post draft and refuses a slug already in use. `openblog init` offers one session to a person at a terminal (`--no-voice` skips it). See [Write a voice sample from the terminal](docs/admin.md#write-a-voice-sample-from-the-terminal).
  - In Admin, the Voice view (`#/voice`) runs the same session on a clock the server owns: draw three prompts, choose one, write with spell-check, autocorrect and writing suggestions off, and the draft locks at zero or on Finish early. A draft survives a reload or a lost connection (it is kept on the server and a bounded copy on the device, and a late save is refused), the locked rough draft is shown read-only exactly as written, and a polished copy has Reset to rough, a revision-checked Save, an unsaved-changes guard, Make portable or Make private, and Make a post draft. The Sample library (`#/voice/library`) groups samples by pack with Rough and Polished badges, coverage, and unreadable files listed with what to do. The view is keyboard and screen-reader friendly, comfortable on a phone, and offered once on the Admin home in a "Gather your voice" card that Dismiss silences for good. Private voice text on the device is dropped after a day (rough) or 30 days (polished) and when you sign out. See [Write a voice sample in Admin](docs/admin.md#write-a-voice-sample-in-admin).
  - With the Assistant, voice samples and a voice guide can be chosen as context (up to 8 samples and 120,000 characters per request, refused before anything is sent; the server reads each chosen sample again and sends it as untrusted data). **Propose a voice guide from selected samples** returns a guide in which every line quotes your own words and names its sample, shown as changes against your saved guide, editable, and saved only on Save as portable or private; a guide that quotes private samples cannot be saved as portable. `voice-review` prefers the guide and samples and marks a finding unverified advice unless it names a sample or guide section; the new `voice-match` skill suggests replacements anchored to exact passages, never applied when they do not anchor; completion can lean on a selected guide. The engine guide (now version 5) teaches what samples, stages and the guide are. See [Use voice samples and a voice guide with the Assistant](docs/admin.md#use-voice-samples-and-a-voice-guide-with-the-assistant).
  - Your voice library can move between projects: `openblog voice export` puts your samples and guide in one JSON file (private material only with `--include-private`, and such a file is never written inside the project outside `.openblog/private/`), and `openblog voice import` previews every file it would create or replace, refuses anything invalid or in a newer format, and writes all of it or none. An import keeps each item in its folder, never replaces a rough draft, and never lets a guide that quotes private samples into the portable folder. See [Move your voice library between projects](docs/admin.md#move-your-voice-library-between-projects).
  - Pre-release audit fixes: a terminal session never loses saved text when the editor file cannot be read, refuses a second window, and leaves the session open when the editor returns without waiting (use `code --wait`); piped text without a prompt id is an error. A scrap names its session, a lock never turns a scrapped session into a rough draft, and a resume waits out the lock grace. The library lists every answer to a prompt and shows the same gap list as `voice --list`. A guide proposal that keeps claims from a private guide cannot be saved as portable, and Save as private is the default. Admin errors never mangle sentences or show the project's path when served from the current folder; samples save on drives without hard links and are never written through a folder link; a site inside a larger Git repository gets its own ignore rule; import refusals never repeat file text; erase also removes a half-written session record; the "30 seconds left" announcement is always spoken; and device copies survive an ended sign-in for the same author.
  - A proposed voice guide is folded into your saved guide (ADR 0288). Traits it does not address and your own text are kept word for word, each changed trait is shown with both texts and you choose Keep current or Take proposed before saving, and a kept quote whose sample is gone or changed is flagged, not dropped. A guide that carries quotes from private samples still cannot be saved as portable.
  - The voice guide moves between portable and private in one step (ADR 0289). `openblog voice guide --move portable|private` shows what would move (`--yes` moves it), and Admin has Make private or Make portable on the guide's card. The file is copied, checked and only then removed, so it is never lost. Links are refused, and a guide that quotes private samples or cannot be read stays private.
  - Assistant review can cover the selected text or the current section as well as the whole document (ADR 0290). Findings stay inside that passage, a skill is offered only for scopes it declares, and `voice-match` now works on a passage only, so you choose what should sound more like you. Apply and undo work as before.
  - Samples are private unless you choose portable, and you can erase them (ADRs 0282 and 0283): a move between the folders is reversible and a build or publish never carries a private sample. `openblog voice erase [--yes]` and the Admin **Erase all voice data…** button list every sample, the session record, the voice guide and leftover editor files, ask you to confirm (`--yes`, or typing `erase`), remove them all or none, check again that nothing is left, and refuse a linked folder. See [Erase your voice data](docs/admin.md#erase-your-voice-data).

## [0.50.0] - 2026-10-28

- The landing page and Customize look (epic #314, ADRs 0245 to 0264, overview in ADR 0265): owners arrange their home page and choose their site's colors and fonts from Admin, from a phone, without HTML or CSS. Docs: [the Landing page and Customize look in Admin](docs/admin.md#change-your-home-page-and-your-look), [Landing page sections](docs/content.md#landing-page-sections), [Look controls](docs/themes.md#look-controls) and [the `ob-home-*` classes](docs/theme-components.md#styling-the-landing-page).

- The home page can be built from landing sections. A site that adds `content/landing.json` (a versioned list of welcome banner, rich text, latest posts, series, featured post, buttons, image, video, map, opening hours, contact, social links, FAQ and call-out sections) gets those sections, in order, on the first home page; a site without the file, or with no visible section, is built exactly as before. Text in a section is never read as HTML: markup typed into any field, including Markdown, shows as plain text. Admin gains `GET`/`PUT /admin/api/landing`, which save the file atomically against a revision and refuse stale writes. A file that cannot be used is a build warning and the site falls back to `home.heading`, `home.intro` and `home.showSeries`. The sections are styled once in `web/base.css` from `--ob-*` tokens, so every bundled theme shows them legibly in light and dark, with 44px touch targets, visible focus rings and no motion under reduced-motion. 

- Admin has a Landing page builder at `#/landing`. The home page's sections show as cards you can add from a plain-language picker (each type has a description and a sample), edit in a simple form, move with Move up and Move down buttons (or Alt with the arrow keys), hide, and delete with an Undo. Fields are checked in plain words next to the field, nothing takes HTML or CSS, and nothing is written until Save. The builder has a live preview of the home page built from your unsaved changes (Phone, Tablet and Desktop views you can switch with the keyboard, a full-screen sheet with Back on a phone, beside the builder on a wide screen); the preview never saves or publishes. Saving the landing page now rebuilds the served site, as saving a post does. The builder works with one thumb on a phone: one column from 320px, controls at least 44px, the right keyboard for addresses, emails, phone numbers and numbers, a Preview, Save and Publish bar that stays at the bottom, rides above the on-screen keyboard and never covers the field you are typing in, and a preview beside the builder on wide screens. It respects reduced motion, large text and 400% zoom. Publish saves your changes first. Unsaved landing page changes are kept on your device, offered back as "Restore your unsaved changes" after a reload, crash or lost connection (and kept in memory for the visit if your browser blocks storage), and you are warned before leaving with unsaved work. If someone else, or you on another device, saved a different landing page first, saving no longer fails silently or overwrites: you choose Keep mine, Use the newer version (your changes are put away so you can restore them) or Compare. A home page whose first latest-posts list is shorter than the archive and carries no pager now ends with an "All posts" link to the archive. 

- Start your landing page from a ready-made layout: Welcome, Small business, Portfolio or Newsletter, each with clearly marked sample words to replace, or Start from scratch. A first visit offers the choices; Choose a ready-made layout and Reset to default are always there. Choosing one is unsaved until you save, can be undone, and asks first before it replaces sections you already have (ADR 0258).

- The landing page builder is easier for first-time owners: plain words everywhere ("web address", "picture description", "video code"), every problem message says what to do next, an empty page points to the ready-made layouts, Publish is explained as "make it live", a short Help list explains the words, and an optional three-step tour (skippable, keyboard and screen-reader friendly, never shown again once closed) introduces the page (ADR 0259).

- The landing page's Text section is now written like a word-processor document instead of in a box of Markdown. It uses the same Visual surface as the post editor, with a toolbar of words: Paragraph, Heading, Bold, Italic, Link, Bulleted list, Numbered list, Quote, Image (a description is required), Undo and Redo. The buttons are touch sized, work with the keyboard and a screen reader (the toolbar is one tab stop you move along with the arrow keys, and each button says whether it is on), and stay in view while you write. Link and Image ask in plain words on the page. There is no Markdown view, no HTML view and nothing that accepts markup; pasting brings in plain words only. The section is still saved as Markdown, text written earlier loads as formatted text, and opening it and saving without a change leaves it exactly as it was.

- Pasting from Word, Google Docs or a web page into the landing Text section or a post's Visual mode now keeps headings, bold, italic, links and lists and drops fonts, colors, scripts and everything else; a pasted picture with no description is left out and flagged, and Ctrl/Cmd+Shift+V pastes plain text. Text typed in a Visual surface that looks like a tag is saved as plain words (`&lt;`), never as raw HTML (ADR 0260, ADR 0261). 

- Plain-language suggestions under the landing Text section and the post editor: a picture with no description, a link that says "click here", an empty link, a skipped heading level, a very long paragraph, text in all capitals and an `http://` address each get one short sentence and, where it is safe, a "Fix it" button that changes only that spot. Suggestions never block saving (ADR 0262).

- Earlier versions of the landing page: every save is kept (the last 20) in private storage under `.openblog/private/landing-history/`, outside the content folder and out of builds, feeds, exports and Git. A History section in the Landing page view lists them by date with a short summary, previews one in a script-free frame, and restores it with one button; a restore is a normal save that keeps the page it replaced, and it is refused with the usual choice if the page changed somewhere else (ADR 0264).

- A library of pieces for posts and the landing page: button, image with caption, video, map, opening hours, contact details, social links, questions and answers, and call-out. Each is a few form fields, validated and escaped by the engine, with required alt text, `https`-only providers and no way to type HTML. In a post a piece is a `piece` fence of `field: value` lines (a call-out stays the `> [!NOTE]` call-out), so Markdown remains the saved format and posts that do not use the new fences build unchanged. Videos (YouTube without cookies, Vimeo with do-not-track) and maps (OpenStreetMap) are now lazy-loaded, titled frames with a plain link beside them, on the landing page too, where they were links before; portable exports keep only the link. `GET /admin/api/meta` lists the shared form schema as `pieces`. See [Pieces](docs/content.md#pieces-buttons-videos-maps-and-more) and ADR 0253. 

- An **Add something** button in the post editor's toolbar, in both Visual and Markdown mode, opens a dialog that lists the pieces in plain words (button, image with caption, video, map, opening hours, contact details, social links, questions and answers, call-out), asks for their details with labelled fields and large touch targets, and writes the piece's Markdown at the caret. Problems are explained beside the form and nothing is inserted until the engine accepts the piece; Escape or Cancel changes nothing and focus returns to the editor, and Undo takes the piece back out. There is no option to write HTML. See ADR 0255. 

- The Visual editor edits callouts, tables, task lists, embedded videos and pieces with forms instead of locking them. Each such block now has an **Edit** button that opens a labelled form inside the block (callout kind and text; table rows and columns; task items and their checkboxes; an embed's provider and address; a piece's details), writing the same Markdown as before. Escape or Cancel leaves the block untouched, an unedited post is saved byte for byte, and knowledge checks, footnotes and raw HTML stay protected. `POST /admin/api/pieces` checks a piece with the build's own rules and returns its Markdown. See ADR 0254. 

- Customize the look with simple presets, never CSS: a new optional `appearance` setting in `openblog.json` holds an accent color, one of eight curated looks (Calm, Warm, Bold, Night, Garden, Paper, Ocean, Sunset), a font style, a text size, corner roundness, spacing, page width and heading weight. Every value is a closed choice or a strict hex color, and the engine compiles only allowlisted `--ob-*` tokens from them, so no text can reach the stylesheet. An accent that would be hard to read is nudged just enough to pass WCAG AA in both light and dark (and more strictly for visitors who ask for higher contrast), with a plain sentence saying so. Themes may list the controls they honor in `customizable` (omitted keeps every current theme valid). `GET`/`PUT /admin/api/look` read and save the look with a revision check, touching nothing else in `openblog.json`. A site without `appearance` builds byte-for-byte as before. The Admin screen is described next. Saving a look rewrites `openblog.json` through serde_json (keys sorted, formatting normalized, values preserved), the same as the existing Appearance save; a byte-preserving config save is a possible future change for all Admin config saves. See [Look controls](docs/themes.md#look-controls) and ADR 0248.

- Admin has a Customize look screen at `#/look` (a tab, and a button on Appearance). Owners change their site's colors and fonts by tapping choices: eight ready-made looks with light and dark swatches, a main color from swatches or a color picker, sample cards for the font style, and Text size, Corners, Spacing, Page width and Heading weight in plain words. Only the controls the active theme honors are shown, with a kind note about the rest. No field takes text or CSS. A live preview of the home page is built from the unsaved choices (Phone, Tablet or Desktop; Automatic, Light or Dark) and never saves; a color that would be hard to read is adjusted and the screen says so. Every control has Back to theme default, and Reset everything and Undo take choices back. It works with one thumb on a phone (one column from 320px, 44px targets, a bar with Preview, Save and Make it live that stays at the bottom), keeps unsaved choices on the device, and a save that finds a newer look asks (Keep mine, Use the newer look or Compare) instead of overwriting. New `POST /admin/api/look/preview` builds that preview in memory and writes nothing. Color and font choices wrap instead of overflowing at 200% text on a 320px screen. 

- Safety audit of the landing, look and piece features: landing and piece requests are size-bounded before they are read, a piece request is limited to 64 values, refusals no longer repeat a bad section id or a look value that holds markup or CSS, and tests now cover the authorization matrix, malformed and unknown payloads, the exclusion of landing text from feeds, search and every other generated file, and a scan that fails if an Admin form gains an HTML or CSS field. Markdown mode keeps accepting raw HTML (existing posts are untouched) and now notes a tag in the suggestions (ADR 0263).

## [0.49.0] - 2026-10-28

- The container can publish with a repository-scoped SSH deploy key (`OPENBLOG_GIT_SSH_KEY_PATH` and
  `OPENBLOG_GIT_SSH_KNOWN_HOSTS_PATH`) instead of a token. The image now ships `openssh-client`; host keys
  are pinned and verified strictly, Git metadata recovery on Render uses the same key, and the entrypoint
  refuses to start if both a key and `OPENBLOG_GIT_TOKEN` are configured. A new `tests/docker-entrypoint.sh`
  check runs in CI.

- The home page now uses the configured `home.heading` as its one `<h1>` on every listing page (it was an `<h2>`, so the page had no primary heading). The "Series" heading stays an `<h2>`.

- The Web Sandbox source tabs (HTML, CSS, JavaScript) are now a proper underlined tab strip, with a hover state and a larger touch target, instead of loose outlined buttons.

## [0.48.0] - 2026-10-28

- Export, delete and send a copy of your readings (with `readerAnnotations.enabled`): each reading can be deleted (after asking, and checked afterwards) or all readings of a post removed; the export preview says how many reflections are left out unless you include them; and a reading can be sent as a separate, previewed Third Perspective copy only after you agree to publication, through the site form where there is one or by copying it yourself. Nothing is sent or recorded as sent unless you do it, and the reading itself stays private and unchanged. See [reader annotations](docs/specs/reader-annotations.md).
- Compare your readings over time (with `readerAnnotations.enabled`): a "Your readings over time" region on each post where a reader can save how they read it as a private snapshot, add a label, and put any two readings side by side (or one after the other on a small screen), with a note beside each saying whether the post has changed since it was written. Nothing is sent, scored or summarised, and without JavaScript the region explains what it needs. See the [reader annotations contract](docs/specs/reader-annotations.md#comparing-readings-on-device).
- Private interpretation history, data layer (with `readerAnnotations.enabled`): the reader's local annotation document (now version 2; version 1 documents migrate) can hold reflection snapshots of a work or section, each kept unchanged with the page revision the reader read, a label they chose, and a link to the earlier reading it follows, with stale and article-changed state worked out each time. They stay on the device, are left out of the default export, and can be imported with the same all-or-nothing checks. A bounded copy for public consideration is built only on the reader's explicit consent through the existing Third Perspective form and moderation path, and never converts or marks the local original as public. No page shows it yet. See [Reader annotations](docs/specs/reader-annotations.md#interpretation-history).
- Admin curation no longer ignores a withdraw, select or unselect made while the site is rebuilding after a
  reorder; the change waits for the rebuild and is then saved.
- Reader export, import and privacy controls (with `readerAnnotations.enabled`): the trail panel can download a dated JSON file of the reader's highlights, sources and trails (their own notes left out unless they tick a box, with a sentence saying exactly what the file holds first), preview a file before importing it (what it would add, what is already saved, records that disagree and which version stays, imported highlights on this post that no longer match its text), refuse hostile, newer, oversized or unreadable files whole without changing anything, turn highlights, notes and trails off in this browser without losing the data, and show what is kept and which storage keys are used so an erase can be checked. Nothing is uploaded. See [Reader annotations](docs/specs/reader-annotations.md#export-import-and-privacy-controls).
- Reader reading trails and saved sources (with `readerAnnotations.enabled`): a second region on each post, "Your reading trails and saved sources", where a reader can save the post or a reference it cites (kept with the post it was found in), start named trails by hand, add sources, highlights and notes once each, reorder them with buttons, list the posts they have marked, and remove one source, trail step, trail, or post's highlights, or clear everything, each after asking. Nothing is recorded as a reader reads; everything stays in the reader's browser, a change that cannot be saved is refused with the reason and leaves saved data as it was, and the region says what it needs without JavaScript. See [Reader annotations](docs/specs/reader-annotations.md#reading-trails-and-saved-sources-on-a-page).
- Reader highlights and private notes (opt-in with `readerAnnotations.enabled`): readers can select words, highlight them and keep private notes on a word, a section or a whole post, by mouse or keyboard, with no account. They stay in the reader's own browser, are painted over the post without changing it, are looked up again on each visit and kept, with the reason, when the post has changed, and still work for reading when the browser denies or has filled its storage. Sites that do not opt in are unchanged. See [Reader annotations](docs/specs/reader-annotations.md#highlights-and-notes-on-a-page).
- Reader annotations contract: the portable, versioned format that readers' local highlights, private notes, saved sources and reading trails will share, with exact/prefix/suffix text targets, stale detection when a post changes, strict validation that names the faulty record, and an export that leaves note text out unless the reader includes it and always states it is private. Nothing is stored or shown yet, so pages and builds are unchanged. See [Reader annotations](docs/specs/reader-annotations.md).
- A published interpretation comparison with explanations now has `portable.html`, `portable.md` and `portable.txt`
  beside its page in the site build. They list every approved
  explanation level as a labelled supplemental section with its authors, prerequisite, language, revision,
  AI label and the author's approval, plus a link to the canonical page. Drafts, unapproved or withdrawn
  explanations, the approver's login and rankings are never included, and a copy that drops a level or an AI
  label stops the build.
- Explanations on an interpretation comparison follow the reader's reading mode. An explanation the author offers
  only in Guided or Deep dive is left out of the other mode, with a note, a "Show all explanations" button and no dead
  control (Deep dive shows Guided explanations too); Standard and any
  page without JavaScript show every explanation. The page also shows an explanation's revision and a link to the
  explanation it translates. The choice stays on the reader's device and the evidence is never changed.
- Audience explanations can now state more. An explanation in an interpretation comparison may name its
  authors, a prerequisite ("helpful to know first", never a barrier), the reading modes it serves, its
  language and the explanation it translates, and the author can withdraw it without deleting it. An AI
  draft still reaches no page without a current approval of its exact text, and editing the byline,
  prerequisite or language withdraws that approval. Existing comparison files are unchanged.
- Interpretation comparison fixes. An AI-drafted reading's approval now covers its attribution, uncertainty
  note and language as well as its statement, so changing any of them withdraws the approval. A published
  page says the author approved an AI draft and never shows the approving Admin login name. An explanation
  may cite only evidence its reading already cites, so no level choice changes the evidence on the page.
- Interpretation comparisons now have regression coverage and a guide. The publication boundary lists the
  comparisons a build publishes (Admin's **What will be public**, and the output check refuses a page for
  one it does not), published comparisons are found by site search from their approved text only, and
  `openblog check` warns, while `interpretations.publish` is off, when comparison files sit beside a page
  or post that would collide with `/interpretations/`. Tests prove an unapproved, stale or revoked AI
  draft and a private note reach no output. See the [interpretation comparisons guide](docs/interpretation-comparisons.md).
- Interpretation comparisons can now be published. Turn on `interpretations.publish` and each published
  comparison becomes a page at `/interpretations/<slug>/`, with an index at `/interpretations/`. Every page
  says who advances each reading and how firmly, shows the evidence each cites, lists the relations between
  readings without ranking them, and offers the beginner, student and scholarly explanations as sections of
  the same page that you can reach by link without JavaScript. With JavaScript a level selector narrows the
  explanations; it never changes the evidence and print shows every level. Evidence appears only for approved
  claim links the site already publishes (with `claimEvidence.publish` on). A reading attributed to a source
  the site does not publish is left out, and the build tells you by id. The comparison files are never copied
  raw into the site. See [ADR 0232](docs/adr/0232-a-comparison-page-is-static-html-from-the-projection-with-levels-as-sections-a-selector-only-enhances.md).
- Admin Studio can author interpretation comparisons: **Content → Comparisons** lists, creates, edits and
  moves comparisons to the trash. Every reading needs an attribution (or an explicit unknown author), you can
  link evidence and see in words whether it is public, private or not found, and missing evidence never
  blocks saving honest uncertainty. Text an AI tool drafted stays a draft until you press **Approve this
  exact text**; only that action records an approval, a save can never add one, and editing the text
  withdraws it. Withdrawing an approval in a published comparison asks before returning it to draft. The
  preview is the public projection with a list, for you alone, of what readers will not see. Saves are
  refused when the file changed elsewhere, and source mode keeps fields the release does not know. Publishing is a separate switch (ADR 0232). See [ADR 0231](docs/adr/0231-comparisons-are-edited-in-admin-with-an-approve-action-that-only-the-server-can-give.md).
- Interpretation comparisons now have a file format. `content/comparisons/<slug>.json` sets two or more
  attributed readings of one subject side by side (a named person, a library source, or an explicitly
  anonymous author), with neutral relations such as "differs from", an uncertainty note, evidence references,
  translations and optional beginner, student and scholarly explanations. Nothing marks a reading correct,
  and an explanation never replaces your prose. An AI-drafted reading or explanation is labelled and is
  published only after you approve its exact text; editing it withdraws the approval. The site reads them only while `interpretations.publish` is on (ADR 0232). See [ADR 0226](docs/adr/0226-a-comparison-is-its-own-public-content-type-and-one-versioned-file.md).
- Optional update subscriptions: a pluggable, double opt-in service for readers who ask to hear when later work takes up a question, with no provider as the link-only baseline. Requests are confirmed once within 48 hours, answered alike so they reveal nothing, and unsubscribe or deletion erases the address with no account. Hosted storage is additive SQL in `supabase/subscriptions.sql` (rollback in `subscriptions-rollback.sql`), behind `OPENBLOG_SUBSCRIPTIONS_ENABLED`. No page renders a form yet, and no function, mail transport or unsubscribe page exists yet, so readers cannot subscribe until a follow-up adds them.
- Continuation links: a canonical page now shows "Where this question went" and, on the later work, "Earlier questions this continues" as plain links that work without JavaScript, built from `continuations.json`. Admin links an approved reflection, question or source suggestion to a later published work, previews it, removes it, and drops the links of a removed or withdrawn submission, telling the moderator plainly if they could not be dropped. A note cannot claim cause, endorsement or popularity. Update subscriptions are not part of this change.
- Reading paths are now easier to find and to move. A post or atlas entry that is a step of a listed path
  shows "Part of a reading path" with a link to that step; listed paths appear in site search; and
  `paths.json` lists the listed paths for tools. Unlisted paths are in none of these, feeds never carry
  paths, and nothing about post order changes. `openblog paths export` writes your published paths to one
  file (add `--drafts` for drafts) and `openblog paths import <file>` checks it and says what would change;
  nothing is written unless `--write`, and any problem writes nothing at all. See
  [Reading paths](docs/specs/reading-paths.md#discovery).
- With `readingPaths.publish` on, a published reading path is now a page at `/paths/<slug>/`: its steps in
  the order you chose, each linking to its post or atlas entry with your reason and relationship (never
  more than you wrote; order alone is not influence), previous and next links, and your rationale and
  prerequisites notes. It works without JavaScript. `/paths/` lists the paths you leave listed; an unlisted
  path keeps its page but is not listed or in the sitemap. Readers can optionally mark steps as read, kept
  only in their own browser, with a link to continue and a reset. A draft step is left out with no trace,
  and problems are build warnings for you alone. A path file named like a Windows device (`con`, `nul`, ...)
  is refused, and unknown numbers in a path file are written back digit for digit. See
  [Reading paths](docs/specs/reading-paths.md#pages-and-progress).
- Admin Studio can curate reading paths: **Content → Reading paths** lists, creates, edits, reorders (with
  Move up and Move down, no drag needed) and moves paths to the trash. Steps are chosen from published posts
  and public atlas entries only, a step that is no longer published is marked as one readers will not see,
  every step after the first needs a relationship and your own reason, and a preview shows the public
  projection with diagnostics for you alone. Saves are refused when the file changed elsewhere, written
  atomically in canonical form, and source mode keeps fields the release does not know. Nothing publishes
  a path yet, and a site without paths builds exactly as before. See [Reading paths](docs/specs/reading-paths.md#admin).
- Reading paths now have a defined, checked file format. A path is an ordered list of published
  posts and Knowledge Atlas entries in `content/paths/<slug>.json`, with a rationale per step and an
  author-written reason (and a relationship that never defaults to influence) for every step after
  the first. It is separate from series and changes neither posts nor series. Steps that are not
  published are left out and named to the author only, never in public output. Nothing renders or
  exports paths yet, so existing sites build exactly as before; see
  [Reading paths](docs/specs/reading-paths.md). `influenced` joins two atlas entries only, on an
  uncontested published relationship in exactly that direction; a path that would show a gap (a left-out
  step a later step follows) is withheld whole; fields the release does not define are kept and written
  back; a repeated key is refused; messages never quote a value; and `readingPaths.publish` (off by
  default) is the switch that reserves `/paths/`.

- New `rust runnable check` fence option: a `---checks` line inside a Rust runnable fence separates the
  reader's starter code from hidden `#[test]` functions. **Check my code** sends both to the Rust Playground
  with `tests: true`, reads `test ob_checks::name ... ok|FAILED` (the first line for a name wins, so a test
  cannot be forged by printing), and shows the author's `///` feedback line for each failing check. Checks
  live in a `data-ob-rust-checks` JSON script, never in the editor. Feeds, portable HTML and portable
  Markdown show the starter and tuck the checks into a `<details>` block headed "Spoiler: the checks for
  this challenge"; the semantic-fact check fails an export that loses either.

- New `demo git-practice` kind with `lesson="<id>"`: a guided practice terminal where the reader types each
  Git command and sees what it would print. Lessons are scripted in `ob-practice-model.js` with accepted
  alternates, hints after wrong answers, and long output that opens in a simulated `less` (space, `b`, `j`/`k`,
  `g`/`G`, `q`). The prompt answers to shell keys: Up and Down (or Ctrl+P and Ctrl+N) walk earlier commands and
  restore a half-typed line, and Ctrl+A, Ctrl+E, Ctrl+U, Ctrl+W, Ctrl+L and Ctrl+C edit, clear and cancel the
  line without breaking copy.

- `fetch-lab` takes `lesson="login"`, `"caching"` or `"testing"`. Login simulates a cookie jar with the
  `credentials` option and CORS credential headers; caching simulates `Cache-Control`, `ETag`, `304` and
  `no-store` on a pretend clock the reader advances; testing runs a function against a stubbed `fetch` that
  succeeds, returns 404, fails, times out or returns broken JSON. A plain fence keeps its original presets.

- A new `colorSchemeToggle` setting (`null` follows each page's theme, `true` shows the public light/dark button,
  `false` hides it and follows the visitor's system preference, ignoring any saved manual choice) overrides the
  theme for the whole site. **Admin → Appearance** edits it with the same authentication, CSRF and ETag conflict
  checks as other settings, and rebuilds the site. Theme authors can set the inherited default with
  `options.colorSchemeToggle` in `theme.json`; it is also reported in the theme JSON, so the citation golden
  fixture gained that one field. Existing sites are unchanged until they set it.

- Terminal fences (`bash`, `sh`, `console`, `powershell` and friends) are no longer numbered by default,
  and in a `console` session an output line that starts with `##` (for example `git status -sb`) is output,
  not a comment.
- A series can declare `aliases:` in its front matter and the site can write a `_redirects` file with real
  301s for moved posts, pages and series (`"redirectsFile": true`); alias pages still carry a meta refresh,
  canonical and `noindex` for hosts without redirect rules.

- `<ob-search>` accepts a `no-history` attribute that stops it from writing `?q=` to the page address,
  for a search box that lives in a dialog or panel on another page.

## [0.47.0] - 2026-10-27

- Netlify builds only what it deploys: pull request previews and branch deploys (such as `develop`)
  are skipped, and a production build is skipped when a change touches only tests, docs, top-level
  Markdown files or GitHub workflows. GitHub CI still tests every change.

- New `demo` fence: ```` ```demo <kind> ```` embeds an interactive lesson demo in a post. Kinds are
  `git-sandbox` (an in-memory Git), `fetch-lab` (a simulated network and Web Storage inspector),
  `component-lab` (a live custom element with a shadow root), `js-evolution` (older and newer JavaScript
  run on the same data), `audio-lab` (a quiet Web Audio synth that plays only after Start) and
  `native-lab` (View Transitions, Web Animations, the popover attribute and the observers, each reporting
  browser support). The fence body is its authored fallback, plain Markdown shown to readers without
  JavaScript and used as the portable representation: feeds, portable HTML, portable Markdown and
  syndicated copies carry the caption, the description and a link to the live version on the original
  article, never the element. The `interactive-demo` capability reports a graceful transformation, the
  semantic-fact check fails an export that loses the description, label or link, and an unknown kind or a
  body with raw HTML, images or non-https links fails the build. An empty body uses the kind's own summary.
  The elements (`<ob-git-sandbox>`, `<ob-fetch-lab>`, `<ob-component-lab>`, `<ob-evolution-lab>`,
  `<ob-audio-lab>`, `<ob-native-lab>`) share `web/components/ob-lab.js` and use only `--ob-*` tokens, so
  any theme restyles them; they store and send nothing.
- Series navigation on a lesson is now the same shape on every part and in every theme. The series box
  always shows a previous and a next control: the first part's previous goes to the series overview
  ("Start of series") and the last part's next goes back to it ("End of series"), instead of leaving an
  empty slot. A decorative path of one cell per part shows where you are (`ol.ob-series-path`,
  `aria-hidden`, since the position is already spoken in "Part N of M" and the list). On narrow screens
  the controls stack, and all are at least 44px tall.
- `openblog build`, `serve` and `check` no longer print a `graceful-transformation` or
  `canonical-only-interaction` warning for every quiz, runnable example, sandbox and comment box. Those
  blocks always export as their documented static fallback; `openblog export` and syndication dry runs
  still list them for the post being published.

- A new `code.playgroundLink` setting (default on) hides the **Open in Rust Playground** link from every
  runnable Rust example, portable copy, and export at once. A fence can still override it with
  `playgroundLink=true` or `playgroundLink=false`.

- `openblog import hashnode` now imports each post's subtitle from the public page (the paragraph
  after the title), as the GraphQL source already did.

- `web runnable` examples no longer take keyboard focus when the page loads. Selecting each example's
  first tab used to focus its editor, so the browser scrolled to the last example on the page. Choosing a
  tab or pressing Reset still moves focus into the editor.

## [0.46.0] - 2026-10-27

- Portable copies carry the research context: portable HTML, Markdown and text, syndicated copies,
  full-content feeds and `llms-full.txt` now include the research context you selected for a post, in
  the same words as its page, with every attribution, doubt and piece of evidence, each item linked
  back to its anchor on the canonical page. Summary-only feeds link to the section. A bibliography
  export adds the references you selected and lists what it cannot carry. Copies say what a format
  cannot carry, show an address that is not a link as text, and are refused for that post alone if
  anything selected would be lost. With the switch off, or nothing selected, every copy is unchanged.
  The page now also shows the passages and rights words of each compared version. Anchors on the page
  moved into the reserved `ob-` family (`ob-research-context`, `ob-curated-<id>`) and
  `curated-context.json` says `openblog-curated-context-file`. See
  [ADR 0202](docs/adr/0202-portable-copies-carry-the-public-curated-context-as-labeled-sections-with-links-back-to-the-canonical-page.md).
- Curated research context: a new private file, `.openblog/private/research/selections.json`,
  holds which public research context readers may be given: references to sources, atlas entries,
  relationships, datings and comparisons, and your own attributed comments on a source or an
  entry. Each selection records the revision you saw and lists the public fields you chose;
  attribution, doubt, dissent and evidence always travel with it. Selecting never approves
  anything. Only what the atlas, comparisons and citations already publish can be selected, and a
  source only when a published post cites it or the atlas or a comparison publishes it. A selection
  may be for named published posts, in your order, or for the whole site. One that is withdrawn,
  stale (what it selects changed), missing, unapproved, cyclic or for no published post is
  withheld on its own, with a reason that names ids only. Imported metadata is published with the
  origin you stated or as unrecorded, a missing detail is listed and never invented, and a
  competing dating you did not select is a `boundary:` warning. In Admin, the Research panel beside
  a post has a Selected for readers section to select, order, withdraw, select again and
  unselect, with a preview of exactly what readers get, and the same report appears in What this
  post makes public. `curatedContext.publish` (off by default) turns it on; while it is on, a
  selections file that cannot be read refuses `build` and `check`, naming the file. While it is
  off the file is not read and a site builds exactly as before. A post offered selections is given
  its own order for each of them: ordering one post never moves an item in another, even one offered to
  the whole site, and a draft previews its own selections as they will be when it is published.
  A conflict keeps the half-filled form, and Escape closes only the confirmation or form it is in.
- A site that publishes curated context now also publishes `curated-context.json`, a versioned public
  data file of the selections you made (with who asserts each, how firmly, on what evidence, where
  imported metadata came from, and the revision you selected), the context they need, and each post's
  items in your order with a canonical anchor for each, so Reader Discovery and other tools can reuse it
  without reading anything private. Each post you offered something also gets a static Research context
  section after its text, complete without JavaScript, readable in order by a screen reader, kept whole
  in print and reflowing at 320 pixels and at 400% zoom; what you wrote is shown as text, never markup.
  Both are built from the one public value Admin's What will be public lists. A change in the Research
  panel rebuilds the site you are previewing while curated context is published. With the switch off, or
  nothing selected, a site builds exactly as before; a file over its bound is left out whole with a
  `boundary:` warning. Portable copies carry it too. See the
  [curated context format](docs/specs/curated-context.md).

## [0.45.0] - 2026-10-27

- A post's page now shows the reflections its editors chose to feature, in a "Community perspectives"
  section after the Third Perspectives (RD14): a plain list, in the order each was featured, that says it
  is the editors' choice and not a vote or a sign that anyone agrees, with each reflection's reader (or "a
  reader"), where it came from and when, the words as the reader wrote them, the editors' optional
  note labelled as theirs, and a link to the same reflection among the Third Perspectives. It counts, ranks
  and orders nothing by popularity, needs no JavaScript, reads in print and at a 320px width, and is
  absent when nothing is featured or a feature no longer stands (the reflection came down, its text
  changed, or the post hides the kind). Feeds, portable copies, search and `llms` files carry only the
  existing link to the page. A site with no `community-perspectives.json` is built exactly as before.
- Fixed: Admin now refuses to feature a reflection on a post that hides or locks out the kind, as its
  preview already did; reports a withdrawn, purged or declined feature by that reason even when its
  article is also gone; checks the committed `third-perspectives.json` for the page's reasons; lets the
  site Admin take a feature off or edit its note when the hosted service cannot be asked; and says
  features could not be checked on any failure but a denial. The reader's wording now says taking a
  feature down takes effect when the editors next update the site, that they can agree again from the
  receipt, and that the editors' note is optional.
- Admin can now feature an approved Third Perspective in its post's community section (RD14): a
  "Feature on the post" section on the reflection's card, offered only when the reader agreed to
  feature this exact text, with an optional editors' note (checked so it cannot claim popularity,
  agreement or a count), a preview of what the page will show with the fixed notice that featuring is an
  editorial choice and not a vote, and "Take the feature off". A banner on every tab lists features that
  must come off (the reader withdrew or no longer agrees, or the text no longer stands) or are hidden
  because their article is not published. Selections are kept in a new `content/community-perspectives.json`,
  checked strictly when the site is built, and nothing counts or ranks reflections.
- Readers can now agree, or decline, to let an editor feature their Third Perspective in a community
  section: an unticked choice on the form (separate from publishing, with a note that copies already
  published may remain) and a choice on their private receipt that works while the reflection is
  waiting, being clarified or approved. Agreeing covers the text the reader sees, and a later change to
  the text needs a fresh agreement. Nothing is featured by this alone.
- Admin now shows "Republish without the name" on a published Third Perspective whose reader hid their
  name after approval, on the card and in the banner on every tab. Until that reflection is published
  again the committed `third-perspectives.json` still holds the name (RD10 never offered the action).
  A feature keeps no name of its own.
- Fixed: changing any other part of a reader's consent (such as whether they may be asked to clarify)
  no longer renews their agreement to feature a Third Perspective for text they have since edited.
  Only an explicit agreement for the text the reader sees binds feature consent. Stored consent
  records are read exactly as before.
- Featuring a reader's reflection in a community section is now defined (RD14):
  it needs the reader's own separate consent for the exact text, a change to the text needs fresh
  consent, withdrawal or a declined feature takes it off with no public tombstone, and a featured
  reflection always says whose it is and that choosing it is an editorial choice, not a vote or
  consensus. Nothing counts, ranks or orders features by popularity. Selections live in a new
  public `community-perspectives.json`.

## [0.44.0] - 2026-10-26

- A site that publishes its Knowledge Atlas now also publishes `atlas-query.json`, a small, bounded
  reading of the published atlas for the context previews and relationship trails to come. It holds
  only what `atlas.json` already publishes: approved entries with a short preview, and approved
  relationships in the direction they were stated, with who asserts them, confidence, standing,
  uncertainty and sources, with the pages' own wording (kind, who asserts a position, confidence,
  standing and evidence) already written out so previews never reword it. Nothing private can be
  in it, an atlas too large for it (or one that does not agree with itself) is left out with a
  build warning and without affecting the atlas pages or `atlas.json`, and Admin's "What will be
  public" lists it, its sources and the reason if it is left out.
  A site that does not publish its atlas builds exactly as before.
- A post can link a word to an approved Knowledge Atlas entry by writing
  `[the allegory of the cave](atlas:allegory-of-the-cave)`. Only the words you link are linked, and
  nothing is recognised automatically. The build turns each link into an ordinary link to the
  entry's page that works without JavaScript. If the entry is unknown, not approved or withdrawn, or
  the atlas is off, the words are published as plain text and the build, `check` and Admin name the
  file and the id. Feeds and portable copies keep the words without the link, and Admin's "What
  will be public" for the post lists each linked entry. Posts that do not use the syntax are
  unchanged. A linked word is underlined with dots and read as "(atlas entry)" by a screen reader;
  Admin's preview shows the links the build makes; an `atlas:` link inside an image description,
  a page, a series description or the home introduction is shown as its words with a warning,
  never as a raw address (nor in raw HTML: an `atlas:` `href`, `src`, `srcset`, `poster` and the like
  is removed with a warning that names the document, not the address); and a stray unclosed link
  tag no longer links the rest of the post.

- A concept link in a post now previews its entry. On a page with a concept link, focusing or
  hovering the link (or a first tap on a touch screen) shows a small card with the entry's type,
  that it comes from your approved atlas, the first paragraph of its summary, a work's source, and up
  to two relationships with who asserts them, how firmly and what is uncertain, plus a link to the
  full entry. It reads only the published `atlas-query.json`, works from the keyboard (Tab goes into
  it, Escape closes it and returns focus, nothing traps focus), keeps your place in the page, respects
  reduced motion and fits a 320px screen. Without JavaScript, or if the file cannot be read, the link
  is the ordinary link to the entry page. The card is looked up only when you first show interest in
  a link (focus, hover or a press), never on load. On a touch screen, which has no hover, the file
  is read as a link scrolls into view only when it is under 256 KB (the page says its size); a
  larger one waits for your first tap, and no one who asked to save data is prefetched. The page names the file by its content so a changed
  atlas is never read from a stale copy, a screen reader that focused the link early hears one
  announcement when the card is ready, and a link inside a heading keeps the heading's name.
- Every Markdown form of an `atlas:` link or image is now made safe in one place, so none can leak a
  private entry id into a post, page, series description, home introduction, feed, search or
  portable copy: reference, collapsed and shortcut links, autolinks (which have no label, so they
  show nothing and the build tells you to write `[label](atlas:id)`), and images with an `atlas:`
  address (always refused, their description is shown as text) all show only their words. A raw
  `<ob-concept>` mark is removed from copies and the text projection, and one dropped because it is
  unclosed now warns. A test builds every form to unpublished ids and scans every built file.
- An entry page of a published Knowledge Atlas now ends with a relationship trail: the entry's
  published relationships, and the relationships of the entries they reach, up to three steps away
  and 50 relationships, as a plain ordered list that reads without JavaScript (the first step
  out in full, further steps as their sentence and a link, within a 20 MB site-wide budget). Every step shows
  the relationship in the direction it was stated, which way the trail followed it, who asserts it,
  how firmly, its evidence and what is uncertain; a step that returns to an entry already on the
  trail says so instead of going round again, and each entry it reaches links to its own page,
  which continues the trail. Nothing is inferred: a trail is not a line of influence. With
  JavaScript, controls filter by relationship type, direction, distance and "only contested or
  uncertain" with a status line, the keyboard moves through without a trap, print shows the whole
  trail, and it fits a 320px screen. A site that does not publish its atlas builds exactly as before.

## [0.43.0] - 2026-10-26

- Readers can suggest a question, text, video, audio or other source for the author's future work
  (RD13). Set `"future-suggestion": "open"` in `participation.kinds` and a post gets a "Suggest
  something for future work" form: the reader's own words, an optional public link and source
  details, an optional article it is about, a name the editors may thank them by and an address they
  agree to be contacted at. It goes to the editors' private queue, never to the page; accepting one
  means only that the editors are interested, never agreement, checking or permission to use it, and
  nothing counts, ranks or votes on suggestions. A site with no hosted service shows only its
  `engagement.feedbackContact` (and nothing at all when it has none), and without script the region
  says how to write instead. Pages of a site that leaves the kind off are unchanged.
- Hosted: suggestions are taken through the existing `/feedback` route behind a new opt-in,
  `OPENBLOG_SUGGESTIONS_ENABLED`, with a receipt, five an hour per client and a bound on repeats.
  This needs one additive SQL change: run `supabase/feedback.sql` again. It loosens a check so a row
  may have a page and no passage; every row already stored stays valid. To undo it run
  `supabase/future-suggestions-rollback.sql`, which refuses (and changes nothing) while any
  suggestion row exists, so export and delete them first.
- Editors read suggestions in the Moderation inbox (kind "Suggestions for future work"), decide them
  by the one policy, are shown possible duplicates without a count, and can copy an accepted one into
  a private research note with an explicit button: labelled unverified reader text and where it came
  from, with no name, contact or time, and nothing fetched or published. A suggestion's contact and
  unshown name are cleared by the retention run after `closedDays`, and nothing else is.
- Editors record what became of a suggestion (RD13, #228). In the Moderation inbox an accepted
  suggestion has a "Link to future work" form: the slug of a draft or series, or the id of a source
  in your library, which you made yourself. It records only that link (kept in the suggestion's own
  details, with a private audit event; no SQL change), creates and publishes nothing, and is never
  opened or checked. Each suggestion shows its outcome (held, converted, declined or closed) and its
  links, and an accepted source can show its link and details, marked unverified, to copy into a
  library record by hand. A reader who kept their receipt sees where it stands in plain words: the
  editors are interested, an editor has recorded a link between it and work they are doing (a record,
  not a promise to publish), or it was not taken forward (not a judgement of the idea); never a rank,
  a count or what it was linked to. A linked suggestion's contact and unshown name are cleared by the
  next retention run instead of waiting out `closedDays`.
- Fixes to the suggestion records before release (#227 review): a suggestion whose links would
  pass the hosted column's size once stored is refused when sent, the hosted check lets only a
  suggestion have a page without a passage, the generic feedback route never decides a suggestion,
  and an error in a source's details marks the first detail filled in.
- Fixes to the suggestion records before release (#213 review): one public-address rule for a link
  (the same as the publication boundary's), identifier hints held to the plain-text, link and scheme
  rules, a largest submission that always reads back from storage, a strict stored shape, redacted
  debug output, duplicates grouped by DOI, ISBN-10/13 and link however written and only among items
  the viewer may see, a suggestion's editor view gated by who may see it, a closed linked suggestion
  that no longer reads as declined, series and link targets in the site's own slugs, and a receipt
  and a report that never treat a never-public kind as published.
- A suggestion's reader credit is opt-in and tied to the text they agreed it for (RD13, #228).
  Agreeing to be thanked by name covers the suggestion as it stands; if the reader later clarifies
  it, or changes their mind, the agreement is not offered until they tick it again in their receipt
  ("The editors may credit me by the name I gave for this suggestion"). Editors see it only beside the
  link form ("The reader agreed to be credited as X for this text"), and nothing publishes it.
  Hosted: the receipt route gains a `credit` action; no SQL change.
- Fixed: a suggestion with wide text and long links could be accepted and stored but not read back
  from the editors' inbox; the stored record is now read up to the sum of what its columns bound.

## [0.42.0] - 2026-10-26

- The research checks now have author documentation, [Research checks](docs/research-checks.md),
  explaining every finding in plain language, how to fix it, and what acknowledging one does and
  does not mean, and a regression corpus of invented works, editions, translations, witnesses,
  lecture claims, quotations, interpretations and contradictions keeps every check producing its
  finding, each distinction failing on its own, and no private research reaching a public file.

- `openblog check` and `openblog build` now review the sources your opted-in posts cite: a
  quotation (a block quotation or quoted words with a citation) that gives no location, or only
  a chapter or section; a page in an edition recorded in several volumes that names no volume;
  a quotation of a work whose editions or translations are recorded; and a post that cites one
  source under two records with the same DOI or ISBN, or several versions of one work.
  `openblog check` also reviews the private source library and notebook: two records with the
  same identifier (an ISBN-10 meets its ISBN-13), two DOIs on one record, an ISBN on a work whose
  editions are recorded, a translation without a translator, a witness without its repository or
  shelfmark, and a passage without a location. Every prompt is advisory, runs offline, changes
  nothing and names records by id; none says whether a source or quotation is accurate.

- Research checks now have one report. Every check on your research (the research profile and
  citations, claims and their evidence, source review, atlas, chronology, comparison and context
  link checks, and the private files a build reads) is gathered into the same findings, with the
  same codes in the same order, wherever you look. **What will be public** in the research
  workspace lists them under what the next build publishes, with where each one is and how to
  repair it; **What this post makes public** and the Research panel beside a draft show the same
  checks for one post, with **Review research checks** opening the review before publishing.
  `openblog check`, `openblog build` and the preview server print the same findings, grouped the
  same way, and `openblog check --json` writes the report as deterministic JSON. `check --json`
  always prints one JSON document on standard output, with the full report shape (empty when the
  site could not be loaded) and an `error` field when the site could not be loaded or its checks
  failed, and exits as `check` does: `openblog check` now also exits with an error, after printing
  the report, when a failure of a private file the build reads would refuse the next build.
  `check` and `build` list each finding once, in the report, instead of also printing it as an
  `evidence` line, and a research site that raised nothing prints `Research checks: nothing to
  review`. The report covers every saved post, drafts included, wherever you look, and a post's
  own review now includes its source-review findings. A finding you have considered can be
  acknowledged from the keyboard; it stays listed and counted, is never called resolved, and the
  acknowledgement stops applying when the finding changes. Only a failure of a private file the
  build reads stops a build (an unreadable or invalid claims file included, while the site
  publishes claim evidence), and it stops it before any public file is written. A production
  `openblog build` counts findings about posts it does not publish yet, as "N finding(s) in posts
  not yet published; see `openblog check`", rather than naming them; `check`, Admin and `serve
  --drafts` list each one. Sites without research print exactly what they printed before. The
  review before publication and the readiness report now share one contract, so acknowledgements
  you already made keep working.

## [0.41.0] - 2026-10-26

- A site can choose the reading mode its posts open in. Set `readingModes.default` in
  `openblog.json` to `guided` or `deep-dive`: a post that opts in with `readingModes: true` and
  names no default of its own opens in that mode. A post's own `readingModes: {default: ...}` still
  wins, a reader's saved choice beats both, and a site that does not set it keeps opening in
  standard.
- Printing a post says what it left out: one line, "Printed in Standard mode; 3 supplements not
  shown.", appears only on paper.
- Reading modes are safer to read and easier to style. The control says in a visible note that the
  article is the same in every mode and that everything outside the labelled supplement boxes is the
  article. Each shown supplement has a "Skip this ... supplement" link, seen when it has focus, that
  moves past it. A supplement holding a warning or caution is never hidden, even when its marker was
  lost, and the page keeps the box drawn in forced colours and in print. Passage feedback and
  claim sections follow the same heading ids as the page in a post with supplements. The stable
  class, attribute and custom-property hooks for themes are documented.
- Guided and deep-dive layers now appear progressively and keep your place. With script on, the page
  no longer paints every layer and then hides some: the layers the post's default mode hides are
  hidden from the start (and come back by themselves if the script never loads), a mode change keeps
  the paragraph you are reading where it is, and a hidden layer can still be found with find in
  page or a link, which show it. A link to the address already shown now reveals a supplement too.
  Without script every layer is still in the page, labelled, and portable copies keep them all.
- Reading-mode fixes. A supplement written inside a warning or caution callout is no longer hidden.
  A change in another tab no longer re-hides a supplement you opened or drops your focus. The
  "Use the author's default" button keeps keyboard focus. The saved choice is now kept per site
  folder, so GitHub Pages project sites on one account no longer share it (readers choose once
  again). With reading modes on, ids you wrote that start with `ob-supplement-` are renamed by
  their exact value (Markdown links to them follow) and reported, a NUL character is read as a
  replacement character, headings keep their old slugs when reading modes are off, and
  `readingModes: {enabled: false}` turns them off while an unknown key is reported.
- Defined author-approved supplements and reading modes, ahead of the reader controls. A post that
  opts in with `readingModes: true` can mark a block quote `[!supplement kind=definition
  level=guided]` as extra context (definition, context, evidence, relationship, comparison, further
  reading, or any other kind). A reading mode only shows or hides supplements: standard shows none,
  guided shows guided ones, deep-dive shows both. Nothing about the article changes in any mode, a
  supplement's words are not counted in the post's word count or reading time, and without script
  every supplement is shown, labelled, in the page, feeds and portable copies. Posts that do not
  opt in are unchanged.
- Readers can choose standard, guided or deep-dive reading. A post with supplements gets a "Reading
  mode" group of three radio buttons, each saying what it adds, with a reset to the author's
  default. It works from the keyboard and with a screen reader, announces each change, respects
  reduced motion, reflows at 320 pixels and 400% zoom, and remembers the choice on that device only
  (never sent anywhere; the page works when storage is blocked). Without script nothing is hidden.
  A link into a hidden supplement shows it. Write `readingModes: {default: guided}` to open a post
  in another mode. A supplement that holds a `[!WARNING]` or `[!CAUTION]` callout is always shown.
- Supplements are clearer and safer to write. Each one has a visible boundary even without a
  stylesheet (a labelled quote ending with "End of ... supplement"), headings inside it stay real
  headings that do not join the outline or renumber yours, a recipe no longer reads its lists as
  ingredients, and a marker the build could not read is listed in the build, `check` and Admin
  warnings with the post. Fixed a crash on a citation inside a supplement.

## [0.40.0] - 2026-10-26

- A reader's Third Perspective about one author's section of a shared reflection, and that
  author's approved response, are now shown on the post, after that author's own words: a labelled
  conversation inside the section's turn, the reader's reflection under "Third Perspective from a
  reader" and the author's under "Author's response from NAME", in order, as plain HTML that works
  without JavaScript or a stylesheet (with script, a long conversation folds behind one button, and
  a link into it opens it). Each author's section now has an `ob-by-...` anchor, a reflection links
  to it, no more than five show after a section (the rest stay in the post's "Third Perspectives"
  list, each shown once), and it reflows at 320px and 400% zoom and prints whole. Admin publishes an
  approved answer into `content/third-perspectives.json` with its reflection (the file becomes version
  2 only while it holds an answer) and takes it off when its author withdraws it or a coordinator
  removes it; the inbox counts any that must come off in the same banner as reflections. Portable
  copies, feeds and `llms` files only link to the canonical post. Where `author-response` is
  `hidden` or `off`, or no answer is published, pages build exactly as before. No SQL changes.
- Credits that are edited after a shared reflection is published can no longer move a section to
  another author: a section now states its contributor in the post, an older post is paired with
  the committed contributor names, and anything that does not match attributes nothing. Admin
  refuses a credits edit that would break it. Approving an answer re-checks the account that wrote
  it against the shared publication, and an author whose membership was removed can still withdraw
  their own answer.
- Readers can write a Third Perspective about one author's section of a shared reflection, and that
  author can answer it, through the moderation you already have. Where a site sets
  `participation.kinds."author-response"` to `open`, a shared reflection's Third Perspective form
  offers "One author's section", chosen by author and place from a list the build writes from the
  post's committed body and credits (never a side of the page). In Admin, the contributor bound to
  that section sees "Answer as ...", on a reflection that is shown, and sends a plain-text answer
  that waits for a coordinator: it is never approved by the account that wrote it, only under a
  reflection that is shown now and about that very author's section, and an author can take their
  own answer back. Coordinators moderate answers in the one inbox. Hosted storage needs no SQL: an
  answer is a row of the existing table, behind the new opt-in
  `OPENBLOG_AUTHOR_RESPONSES_ENABLED=true` on top of Third Perspectives (remove it to turn answers
  off). An approved reflection about an author's section is named by its author on the post and not
  yet linked or answered on the page. Sites that do not set `author-response` build exactly as
  before.
- Groundwork for authors answering a reader's Third Perspective about their own section of a shared
  reflection (nothing is shown or accepted yet): a section is named by its author and its text and
  never by which side it is on, so a note reaches the intended author after layouts change or
  sections move, and says honestly when that section has since changed or gone instead of pointing
  at other words. Only the contributor who wrote the section, signed in as their own bound account,
  may answer as its author; a contributor registry entry alone, a coordinator or a site owner
  cannot. Answers will start pending like everything else and appear only while the reader's note
  does. Nothing is stored or published by this change. Which author wrote a section is read from
  the post's committed credits alongside its body, so it works in static and CI builds without
  private records and is not changed by inviting someone with the same name later. Known change:
  `ob-by-` is now reserved for these section anchors, so a heading whose text begins "OB by" gets
  the id `heading-ob-by-...` instead of `ob-by-...`, and an `{#ob-by-...}` id written in a post is
  replaced by the heading's own id. No post in this repository is affected; other existing posts
  are unchanged.
- A shared reflection's sections now carry one more class for theme authors,
  `ob-turn-by-<contributor key>`, next to `ob-turn` and `ob-lane-N`: the registry key of the
  contributor who wrote the section, which the post's credits already make public. Style it if you
  like, but do not rely on it for anything else. Only composing a reflection writes it, so Admin
  now refuses a manual edit that adds, removes, reorders or changes these classes, or that moves
  an existing section to another author's name or id, whether through the body, the credits or both
  in one save.

## [0.39.0] - 2026-10-26

- Admin Studio gathers Sources, the research notebook, the Knowledge Atlas, Compare and claims
  into one **Research workspace** under `#/research/`, with its own navigation that labels every
  research panel as private research and the draft as publishable, in words that screen readers
  announce. Its first panel, Workflow, leads from a first source to a cited draft and says how far
  your research has come. Switching between the draft and research panels now keeps unsaved
  changes in each, and returns to them exactly as you left them; leaving the workspace, opening
  another document, signing out or closing the page still asks first, naming where the unsaved
  work is. If your session expires, the unsaved panels wait in the page until you sign in again
  as the same user; nothing kept is shown while signed out, or to another account signed in from
  another tab. Notebook, atlas and comparison forms are now protected like the editor. The earlier
  `#/sources`, `#/research`, `#/atlas` and `#/compare` addresses redirect to the same panels.
  Guided and Advanced show the workspace in the main navigation, Simple reaches it from Advanced
  tools and `Ctrl+K`, and Custom lets you choose. Every Admin page gains a skip link, and focus moves
  to the new page's heading after navigation.
- A post's Write toolbar gains **Research**, which opens your research beside the draft:
  search passages, sources, atlas entries, comparisons and interpretations, and insert from them
  without leaving the draft. A quotation goes in exactly as stored, as a block quote with its
  citation checked by the server, and never with its notes; a version whose rights you have not
  stated, or state are reserved, asks you to confirm first. A source gives a citation with
  locators. Links to atlas entries, their datings and comparisons are offered only once the next
  build publishes those pages, and otherwise say what is missing. Private notes are listed only
  on request and go in only through an explicit conversion. Insertions work in Visual and
  Markdown modes, never land in code, HTML or a link, and Ctrl+Z undoes them. Nothing is written
  to your research files.
- Publishing or scheduling a post on the Research profile, or one that publishes citations, now
  opens a **research review** first. It gathers what your research checks already say about the
  post: the research-profile and citation checks, the post's claims, links to atlas entries and
  comparisons the next build will not publish, what a linked atlas entry or comparison leaves out
  or asks you to check, and any private research file the build cannot read. Findings are grouped
  by what the build would refuse, then as detected, potential or needs review, and each one goes
  to its line, field, claim or research object. Only a citation the build would refuse or a
  research file it cannot read stops publishing; everything else is yours to decide, and you can
  acknowledge it. An acknowledged finding stays listed and counted, and asks again once what it
  is about changes. There is no score. Evidence Studio can run the same review at any time, and
  other posts publish exactly as before. Acknowledgements are kept privately in
  `.openblog/private/research/acknowledgements.json`. Sources now opens a source by its address,
  `#/research/sources/<id>`.
- The Research workspace gains **What will be public**, and Evidence Studio **What this post makes
  public**: exactly which research each projection publishes (cited sources, claims and evidence,
  atlas entries, relationships and datings, comparisons, and the research pages a post links to),
  with the fields it copies, and why everything else stays private, from the same projection the
  build writes. Every withheld item opens where it is changed (a claim or evidence link opens its
  post's Evidence Studio once the post is saved). Builds now check their output against it before
  writing anything. A page or JSON artifact naming an item no projection publishes, a damaged
  private file and a private file copied into a public folder refuse the build. A check for text
  from a private research file reads text as runs of six words, so a quote that is hard-wrapped,
  emphasised, linked or joined into the search index matches whatever its markup, and a note
  with punctuation or tags is covered. It refuses only when that text appears in the data the
  build generates from your approved research (the atlas, comparisons and claim-evidence JSON,
  and a post's citation data), read field by field. Anywhere else (pages, feeds, the search index,
  `llms.txt`, static, theme and front-end files, a portable Markdown export) it only warns, with a
  `boundary:` line naming the output, the private file, the record and the field but never the
  text, because the text is in a file you placed or wrote and only you can say whether it is meant
  to be public. A note that lists a post's own headings, your series titles or the address of a
  generated page no longer warns. Every copied text file is checked whatever its extension,
  `paths.web` assets included, and a text file too large to check is named. Private notes shorter
  than six words are not checked by text. A source's web address on a private network (including
  `.corp`, `.test`, `.home`, benchmarking, multicast and reserved ranges, and numeric, mapped,
  compatible, 6to4 and NAT64 forms) or carrying a key, token, signature, secret or password in
  its query or in a `name=value` fragment is no longer published (the rest of its reference is;
  OpenURL `sid`, `#Authorship`, `?author=`, `?sortKey=` and `?design=` are). A source with an
  IPv6 address no longer stops the build. An approved comparison is withheld, and cannot be
  acknowledged, when a passage it aligns was re-located after you saved it approved: saving it
  again does not approve it again, and Compare offers **Checked - approve again** once you have
  checked the place; comparisons approved before this change are not withheld until you save
  them again. Both are printed as `boundary:` warnings.
  `openblog build` adds one line saying how much research it published and withheld, and reads
  your research once instead of several times. Sites that publish no research build byte for
  byte as before.
- In Visual mode, backslash-escaped `*`, `_`, backticks, `[` and `]` are now read as the
  characters themselves. Before, `\*word\*` showed as emphasis and `\[x\](y)` as a link, and
  switching modes could add backslashes to the draft.

## [0.38.1] - 2026-10-26

### Fixed

- With `OPENBLOG_CORRECTIONS_ENABLED` on, Admin no longer drops every Third Perspective from the
  **Moderation inbox**. The hosted function now sends a decision log only with the evidence
  suggestions that take decisions, and Admin reads a Third Perspective whose log is empty (one
  that holds a decision is still refused).

## [0.38.0] - 2026-10-26

- Defined how readers' evidence and the author's correction decisions work, ahead of the forms
  that use them. A suggested source or correction may name the published claim, evidence link or
  citation it questions and a published source with page or other locations; this is the
  reader's statement, never checked for truth or counted. Only the author's decision can make a
  suggestion a correction: accepted as a correction, as a clarification or as evidence (in full or
  in part), declined with the author's reason, or already addressed, linked to the post's revision
  note and claim evidence. Decisions are kept in order and never erase the reader's record, and a
  decision is shown only beside a reader's note that is itself public.
- Readers can name what a suggested source or correction is about, and you can record what you
  decided. With `"evidence": true` in `engagement`, the "Questions and corrections" form offers an
  optional Evidence part on those two kinds: a claim the post publishes, the evidence for it the
  reader questions, a source the post cites or one the site publishes and where in it, and how the
  reader says it bears on the passage, all picked from what the site publishes, never typed. In the
  **Moderation inbox** each note says how it stands (a suggested source, a questioned citation or a
  suggested correction until you decide, never a correction before), shows the reader's evidence
  beside the published claim it names, links notes that seem to be about the same thing without
  counting them, and offers **Record decision**: accept as a correction, a clarification or
  evidence (in full or in part), decline with your reason, or already addressed, pointing at a
  revision note and an evidence link you record separately. A decision never edits your post, its
  citations or the Source Library, never publishes or hides the reader's note, is refused if
  someone decided first or the reader's text changed, and is kept in the item's private record with
  an audit entry. To use it, run `supabase/feedback.sql` again and set
  `OPENBLOG_CORRECTIONS_ENABLED=true`; `supabase/corrections-rollback.sql` undoes it. Without it the
  form and the inbox are unchanged, and evidence the service cannot take is given to the reader to
  copy. Nothing is e-mailed to readers.

- A published suggested source or correction now shows what you decided, in context. Under the
  reader's note on the post, a decision you recorded reads "Author's decision: Correction" (or
  Clarification, Added as evidence, Declined by the author with your reason, or Already addressed),
  with the day, the revision the note was about, the revision note that records the change, linked
  to the post's own Revision notes, the evidence link you recorded, linked to its claim, and your
  rationale. A suggestion you have not decided reads "Unresolved" on a site that takes evidence,
  never as a settled correction, and evidence or a note the post no longer publishes is said, not
  linked. The decision is copied into `reader-feedback.json` (which becomes version 2 only once it
  holds one) when you approve the note or when you record it on a note that is already on its post,
  and never with who decided, a passage check or anything the reader wrote. Portable HTML, Markdown
  and text, full-content feeds and exports gain a "Reader suggestions and the author's decisions"
  section with each outcome, its revision note and evidence links, and a link to the note on the
  canonical page; the reader's own words, `llms.txt` and search stay as they were. A site without
  decisions or evidence builds exactly as before.
- Fixed review findings on corrections: a decision is refused, with the item reloaded, when the
  reader's text changed since you read it; a stored evidence submission still moderates when
  `OPENBLOG_CORRECTIONS_ENABLED` is off; an evidence block that the hosted store could not keep is
  refused before it uses the reader's quota; a revision note or evidence link cannot be linked from
  an item whose post is unknown; the form's lists are built once per site; and
  `supabase/moderation-rollback.sql` drops the decision function.

## [0.37.0] - 2026-10-26

- Approved Third Perspectives now appear on the work's canonical page, in a "Third Perspectives"
  section after the authors' text: each headed as a reader's reflection, never an author's, with
  the reader's name only while they agree to show it and never when it looks like a credited
  name. Approving one in the Moderation inbox writes its public part to
  `content/third-perspectives.json`, so static builds, CI and a site without its hosted service
  keep showing it; removing one, or a reader withdrawing it through their receipt, is taken off
  from its inbox card or from a banner on every tab of the inbox, which counts the published
  reflections that must come off and says when the hosted copy cannot tell. Withdrawing deletes
  the hosted copy only, and readers are told that copies already published may remain and that a
  name they chose to show becomes part of the site's public record. Rolling the hosted opt-in
  back first means emptying `content/third-perspectives.json`. Readers checking a receipt see whether their reflection is waiting,
  needs clarifying, is shown, was not published or was withdrawn, and nothing about anyone else.
  Portable copies, feeds and `llms-full.txt` link to the canonical page for Third Perspectives
  and never carry the reflections. The no-JavaScript text of the Third Perspective form now wraps
  its passage revision at 320px.
- Readers can offer a Third Perspective on a post where `third-perspective` is open in
  `participation.kinds`: their own reflection on the whole work or one section, with an optional
  prompt (never a score or a vote). The form asks them to choose whether it may be published,
  whether their name may be shown and whether they may be asked to clarify it, and sends it for
  review through the hosted function, always pending, with a private receipt to check on it or
  take it back. Without JavaScript, without the hosted service, when sending fails, or when the
  reader does not agree to publish, they get their reflection to copy and send to the author,
  and nothing they wrote is lost. Moderators approve exactly the text and consent they saw in the
  Moderation inbox. Nothing is e-mailed. Hosting it takes `supabase/feedback.sql` run again (one
  new nullable column and one function) and `OPENBLOG_THIRD_PERSPECTIVES_ENABLED=true` with
  receipts.
- Defined Third Perspectives, a reader's own reflection on a shared reflection or post, about the
  whole work or one section. Each one has an optional prompt category (never a score or a side),
  plain text of up to 4000 characters, and a numbered history of what the reader agreed to publish.
  The reader can hide their name or take the reflection back at any time. A reflection is public
  only once a named moderator approves that exact text and consent. It is always shown as a
  reader's reflection, anonymously unless the reader chose to show a name, and never under the
  name of the work's authors or group. A private draft, the submitted copy, the approved response
  and a featured reflection are kept apart. This adds the contract and its checks only; nothing
  is collected or shown yet.

## [0.36.0] - 2026-10-26

- Reader participation now has one policy. Comments keep `engagement.comments` and `comments:`
  exactly as before; questions, suggested sources and corrections, other interpretations, Third
  Perspectives, author responses and abuse reports are each off until `participation.kinds` in
  `openblog.json` switches them on, and a post can choose its own mode with `participation:` front
  matter. Everything submitted starts pending; a request for clarification never publishes the
  text it asks about, removals and dismissed or upheld abuse reports always need a reason, and
  `participation.retention` sets how long unpublished text and the private moderation record are
  kept; comments stay out of retention unless you set it yourself. Nothing is e-mailed to readers.
  Sites that switch nothing on build exactly as before. Passage feedback's `engagement.feedback` is
  now the same as setting its four kinds to `follow-comments`, so each kind can also be set on its
  own: the "Questions and corrections" form offers only the kinds open on a post, and a locked
  kind keeps its published notes on show without taking new ones.
- Comments and reader feedback are now moderated in one place: Admin's **Moderation inbox**
  replaces the comment section of Analytics and the Reader feedback view. It lists every item by
  state (pending, waiting for clarification, approved, rejected, removed, withdrawn) and kind,
  oldest first, and pages through long lists. Each item shows only the decisions you can take on
  it, with their reasons and what each does: approve, ask the reader to clarify, reject, remove
  from the post, or reopen for a fresh decision. A removed or rejected comment can no longer be
  approved straight away, a moved passage must still be confirmed before approval, and a decision
  made on an out-of-date view is refused and the list reloaded. On a shared reflection a
  co-writer moderates as its coordinator, or only reads as a contributing author, and never sees
  a reader's private name. Everything works with the tables you have; to offer every decision,
  with a version and an audit trail for comments, run the new optional
  `supabase/moderation.sql` (and `feedback.sql` again if you use feedback) and set
  `OPENBLOG_MODERATION_ENABLED=true`; `supabase/moderation-rollback.sql` undoes it. Nothing is
  e-mailed to anyone.
- Published reader notes now follow their own kind: switching a kind `off` in
  `participation.kinds` (or leaving `engagement.feedback` unset), or making it `hidden` for the
  site or a post, takes its published notes off those pages until you switch it back on;
  `reader-feedback.json` keeps them. Turning hosted engagement off, or leaving the hosted service,
  still keeps every published note on your pages.
- Readers and owners get protection without tracking. With the new optional
  `supabase/protection.sql` (and `feedback.sql` run again) and `OPENBLOG_PROTECTION_ENABLED=true`, a
  reader who sends passage feedback gets a private receipt, shown once, to check on the note,
  agree to be asked to clarify it, answer a clarification request, or withdraw it, which deletes
  its text and their name at once (set `"receipts": true` in `engagement` to offer this on the
  page). With `"abuse-report": "open"`, readers can report a published note or comment
  anonymously; reports are never published or counted, and upholding one in the Moderation
  inbox removes the item in the same decision. The site Admin can delete a closed item's text
  and name for a reader who asks, and **Moderation inbox → Retention** shows what retention would
  delete before you run it; nothing is deleted on a schedule, comments only if you set
  `participation.retention`, and the database itself refuses to delete any moderation record
  from the last day. Rate limits now keep only an hourly digest of the client, never one
  that lasts across hours, and a note or comment sent twice within the hour is taken once.
  `supabase/protection-rollback.sql` undoes the schema. Nothing is e-mailed to anyone.

## [0.35.0] - 2026-10-26

- The private Knowledge Atlas can now record uncertain chronology. Entries and relationships
  carry datings: each says who dates what (a birth, a composition, a span), on which cited
  evidence and how firmly, at the precision given (a day, month, year, decade or century,
  optionally circa), as a point, a duration, a window ("before" or "after"), an explicit
  unknown, or relative to another entry ("composed after the Phaedo"). BCE years have no year 0,
  calendars are named and never converted, and competing datings are kept side by side and never
  resolved. A relative dating never becomes or supports a relationship.
- The atlas file is now version 2. A version 1 atlas is still read, and its next change writes
  version 2, turning each entry's `bounds` years into a private, unsourced dating by the author
  with nothing lost. Datings are private by default and approval follows the atlas projection.
  The Admin entry form no longer edits years; it keeps an entry's datings unchanged when you save.
- If your site publishes its atlas, the years your approved entries showed from `bounds`
  disappear from /atlas/ pages and `atlas.json` on your next build, and stay gone until you cite
  and approve a dating for each entry. An uncited date is never published. `openblog build` and `openblog check` now warn about this,
  naming each affected entry and how many datings it holds, and Admin's atlas notices list each
  entry too.
- `openblog check` now points out atlas datings that cannot all hold as recorded: a death dated
  before a birth, a work composed after the death or before the birth of the person recorded as
  its author, a publication before the composition, an activity or membership dated outside a
  life, relative datings that order the same works both ways round or in a loop, and a relative
  dating that the absolute dates disagree with. Each notice names the datings by id with the
  values as you stated them and asks you to check them against the cited evidence; it never says
  which date is right, never changes your atlas, and never links entries because their dates are
  close. The summary also says how many datings were indexed. Builds and published pages are
  unchanged.
- Admin Studio's Knowledge Atlas can now add and edit datings on entries and relationships: pick
  what is dated (only what that kind of entry can have), at one point, a duration, a window, an
  unknown date or relative to another entry, at the precision your source gives, with BCE or CE
  chosen separately, circa and the calendar, who dates it, on what evidence or as an unsourced
  draft, with a note and approval. Each dating reads back as you type ("not before the 420s
  BCE"), and keeping your draft after someone else changed the atlas keeps their datings too.
- A new Chronology view lists every dating as text: competing datings of the same thing side by
  side and never resolved, grouped by century, decade or year, with filters for a time window,
  aspect, competing datings and datings to check, and a line saying what is shown. Datings that
  cannot all hold are listed to check, each linking to the dating. Each entry also shows its own
  chronology. Nothing here is published.
- Chronology prompts from `openblog check` are now always listed in the same order, even when two
  parties record the same author.
- Sites that publish their Knowledge Atlas now publish the datings you approved and cited. Each
  entry's page lists its datings by what they date, with who dates each one, how firmly, the cited
  evidence and your note, at the precision given and with BCE written out ("between c. 428 BCE
  and 427 BCE", "the 380s BCE"). Competing datings stand side by side and are never resolved; a
  relationship's datings appear under "When it held". `atlas.json` gains a `datings` list with
  the same fields, the date as data and in words, and the first and last year each covers.
  Unsourced, private and passage-cited datings, datings of unpublished items, datings relative to
  a private entry, and your check prompts are never published, and an atlas without approved
  datings builds exactly as before. The warning about entries without public years now names
  only the entries that still have none.
- `/atlas/` ends with a timeline when datings are published: an ordered list by century of every
  published dating in full, then what cannot be placed in time, then the relative chronology. It
  reads completely without JavaScript and prints whole; with JavaScript you can show one aspect
  or only aspects with competing datings and go to a period from the keyboard, and a status line
  says what is shown. Filters show or hide a whole dated aspect, never one dating or its
  evidence. A dating relative to another entry links to that entry, whose page lists the datings
  that point at it with links back, so relative chronology can be followed step by step; nothing
  is worked out from dates.
- Long unbroken titles in archive-style lists, such as the atlas index, now wrap instead of
  making the page scroll sideways on a phone.

### Fixed

- Keeping your draft after someone else changed the atlas no longer mixes up two pieces of evidence
  that cite the same source and passage. Before, removing or reordering evidence elsewhere could
  make one item lose its stored fields and take the other's (introduced in 0.29.0 for relationship
  and dissent evidence). Evidence now rests on its own stored copy wherever it moved, told apart by
  its locators when several items share a source and passage, and otherwise keeps your draft's copy.
  This repairs keep-draft for relationship evidence from the atlas release, and covers dating
  evidence too.
- On a phone or at high zoom (320 pixels wide), Admin's header now wraps instead of making every
  Admin view scroll sideways.

## [0.34.0] - 2026-10-26

- The private source library can now record more about each version of a work: which earlier
  edition an edition revises, the repository and shelfmark of a manuscript, how many volumes an
  edition has (so a page names its volume), and your own statement of the rights in a version's
  text, which is unknown until you state it and is never a legal judgement. Creators can be
  marked as stated, attributed, uncertain or disputed, and a work can be marked anonymous. The
  library can also hold private interpretations: your own or someone else's rendering or reading
  of a place in an exact edition, translation or manuscript, attributed to a contributor or a
  named person. Contributors named on an interpretation cannot be removed from the registry
  until it changes. Existing libraries read and save exactly as before, and none of this is
  published.
- Editing a creator's name or role in the Admin source form no longer drops its attribution
  certainty or note, and editing a reference's location keeps its volume. A reference to an edition
  or manuscript in several volumes now has a Volume field.
- Building a site no longer fails when an interpretation in the private source library names a
  contributor who was later removed from the registry; `openblog check` and Admin still report it.
- The private research area can now hold passage alignments: your record of which places in
  different editions, translations, manuscripts and interpretations correspond, including one
  place split across several, several merged into one, and a version that lacks the passage.
  Each alignment says who aligned the places and on what evidence, keeps the original wording
  apart from your normalized form of it, and never claims the places mean the same thing. They
  are stored privately in `.openblog/private/research/alignments.json`, checked by `openblog
  check`, synced by the hosted workspace, available to Admin through
  `/admin/api/research/alignments`, and never published. A source, interpretation or passage an
  alignment uses cannot be removed until the alignment stops using it.
- Admin Studio has a new **Compare** research tool for reading aligned passages across editions,
  translations, manuscripts and interpretations, side by side or in a single column (which is also
  how it reads on a phone). Every place names its version, its editor, translator, scribe or
  interpreters, and its locator; original wording is shown exactly, right-to-left text keeps its
  direction, your normalizations appear only when you ask and are labelled, and a version that
  lacks the passage says so. You can add, edit, reorder, and remove alignments and their places
  there, with your draft kept if someone else changed the alignment first. Copy and download take
  only the places you select, carry each version's rights statement, leave out your notes on
  places unless you tick "Include my notes on places", and ask you to confirm when a version's
  rights are unchecked or reserved. Nothing is published.
- A site that publishes its Knowledge Atlas no longer fails to build when an interpretation in the
  private source library names a contributor who was later removed from the registry.
- Sites can now publish the passage comparisons you approve. Turn on `comparisons.publish` in
  `openblog.json`, then tick "Approve this comparison for publication" on an alignment in Admin's
  Compare tool: the site gains `/comparisons/`, a page for each approved comparison and
  `/comparisons.json`. Every place names its version, its editor, translator, scribe or
  interpreters, its locators and the rights statement you recorded. Its wording is quoted exactly,
  in its own language and direction, only where you state the version's rights as permission, an
  open licence, the public domain or your own work, and only up to 1,000 characters; a version
  whose rights are unknown or reserved is identified but never quoted. Interpretations are
  attributed and kept apart from the text they interpret, your normalizations appear only if you
  choose, and your notes on places, rights notes and unapproved alignments are never published.
  Before approving, each place in Compare says what a public page would show; saving rebuilds the
  site at once, as does changing the rights or wording of a source or passage a published
  comparison uses, and clearing approval removes the page. Only the interpretations a published
  comparison uses must be valid for the site to build. The pages need no JavaScript and read on a
  phone and in print. Sites that do not turn it on are unchanged and never read the alignments
  file.

## [0.33.0] - 2026-10-26

- Defined how reader questions, corrections and annotations will point at published text. A
  passage target names a section by its heading id and either the whole section or a short
  quotation with a little context on each side, and is checked against the post as it is now: it
  finds the same words again, even after they moved to another section, or it is reported stale
  with a reason (removed, reworded around it, ambiguous). It never silently points at different
  words, and accents, emoji and other combined characters are never split. A target can also
  point at a whole post, and sections that share a heading id are told apart. The same rules run in
  the build and in a small browser module for the reader features to come, checked against the
  same cases. Nothing uses targets yet, so no page changes.
- Defined what is kept about where each piece of reader feedback came from: the post and the
  revision of its text the reader saw, the passage, when they saw it (by their own clock, if
  given) and when the site received it. A reader's name is shown publicly only if they agree,
  nothing else about them is recorded, and a published note never re-quotes text the author has
  since removed. Research notebooks now refuse reader-feedback fields (`attribution`,
  `receivedAt`, `seenAt`) with a clear message, so feedback cannot be merged into private research
  by accident.
- Sites on Netlify and Supabase can opt in to typed passage feedback: a reader's question,
  suggested source, suggested correction or other interpretation of a passage, sent to the existing
  engagement function with the passage and the revision of the page they saw. It is off unless the
  site turns it on in `openblog.json`, sets `OPENBLOG_FEEDBACK_ENABLED=true` and runs the new
  `supabase/feedback.sql`, which only adds one private table (`supabase/feedback-rollback.sql`
  removes it). Every submission is checked with the same rules as the build, held pending for
  moderation with the time the site received it, and limited by the existing hourly quotas. A
  reader's name stays private unless they agree to show it, nothing else about them is kept and no
  e-mail is collected or sent. Sites that do not opt in are unchanged. Saving hosted engagement
  settings in Admin now keeps settings the form does not show. Reader forms and moderation screens
  come next.
- Readers can now send that feedback from the post itself. On sites that opt in, each open post ends
  with a "Questions and corrections" form: choose the whole post, a section, or words you selected
  in the post (a button appears next to the selection), say whether it is a question, a suggested
  source, a suggested correction or another interpretation, and write your note, with an optional
  name you choose whether to show. The form works with the keyboard and screen readers, announces
  problems and progress, fits narrow phones and changes nothing in the article. Without JavaScript
  the page explains how to send a note; when the service is offline, off or failing, the form
  gives you the note to copy and send to the author, at the address in the new optional
  `engagement.feedbackContact`. Locked and hidden posts, sites that do not opt in, feeds and
  portable copies are unchanged.
- Reader feedback can now be moderated and answered. Admin has a "Reader feedback" view that lists
  what readers sent, by state, through Admin's own server, so the hosted token never reaches the
  browser. Each note shows whether its passage is still where the reader saw it, has moved, or has
  changed or gone; a note about a passage that is not current can be approved only after you
  confirm you read it as it is now. Approve publishes a note, reject and remove need a reason, and
  two people can never act on the same note at once: every decision is checked against the
  version you saw and recorded in a private audit table. Approved notes are written to
  `content/reader-feedback.json`, versioned with your site, without the reader's name unless they
  agreed, their own clock or anything about moderation, and shown on the post's page only, under
  "Reader questions and responses", with the quotation only while the post still has those words.
  You can add a public response to each note and record what changed in the post as a revision
  note (`evidenceRevisions`), which a site that takes feedback now publishes; neither edits the
  post, and nothing is sent to readers. Feeds and portable copies carry a link to the page instead
  of the notes. A note that is approved but not on its post yet, or removed but still on it
  (because the file could not be written, or the decision was made outside Admin), says so and can
  be put on or taken off the post again. Run `supabase/feedback.sql` again to add moderation: it adds two columns, an audit
  table and one moderation function, and changes nothing else.

## [0.32.0] - 2026-10-26

- Defined the format for private claims in draft posts and evidence links that record whether a
  source supports, contradicts or contextualizes each claim, with rationale, uncertainty, review
  state and provenance. A citation alone never asserts support, contradicting evidence cannot be
  hidden while support is published, and nothing judges evidence or scores it. Nothing reads or
  writes these files yet, so no site output changes.
- Withdrawing consent on a claim or a contradicting evidence link is never refused: an approved
  link on a private claim, and approved support beside a private contradiction, stay private and
  are reported as notices instead of making the claims file invalid.
- Evidence Studio in the post editor can now record claims: select words in a saved draft to make
  a claim, then link supporting, contradicting or contextualizing evidence from your notebook
  passages or source library with a rationale, confidence and uncertainty. Supporting and
  contradicting evidence are listed side by side and never combined into one figure. Each claim
  shows whether its words are still where you selected them (verified, moved, stale or
  ambiguous) and can be re-anchored; a stale or ambiguous range is refused without changing the
  draft or the claims. Claims are stored privately in `.openblog/private/research/claims.json`,
  checked by `openblog check`, synced by the hosted workspace, and never reach your site, feeds,
  search, `llms.txt` or exports. A source or passage an evidence link uses cannot be removed
  until the link stops using it.
- Claims now come with evidence gaps and review prompts: a claim with no evidence, contradicting
  evidence without a note on how the post addresses it, only supporting evidence on a claim you
  marked uncertain, a link resting on an archived source or passage, a link with no location or
  no rationale, a location nobody has checked, a suggestion nobody has reviewed, and claim words
  that moved or are gone. Each names what was checked and what to do next, and none says whether
  a claim is true. `openblog check`, `openblog build` (as warnings, only when the private claims
  file is present, and never in the site) and Evidence Studio show the same findings in the same
  order. A claim's anchor that is still in place now reads "In place" rather than "Verified".
- Sites can now publish the claims and evidence you approved: turn on `claimEvidence.publish` and
  each post with approved claims gains a "Claims and evidence" section, readable without
  JavaScript, listing every claim's supporting and contradicting evidence side by side with the
  references, locations, your rationale, confidence and uncertainty, and marking a claim with
  published contradiction as contested. The same text reaches portable copies, feeds and
  `llms.txt`, and `/claim-evidence.json` holds the same data. Support is never published while a
  contradicting link stays private, private notes and passages never are, and withdrawing approval
  removes the item from the next build. Dated revision notes written in a post's front matter as
  `evidenceRevisions` are published in the same section and stay published even when the private
  claims file is gone. Sites that leave the setting off are unchanged.

## [0.31.0] - 2026-10-26

- Contributors to a shared reflection can pin moments to its sources in Admin: a time or range in
  a video or podcast, or a page, chapter or other location in text, with a short quotation (its
  speaker, rights and where the words came from) and their own observation. Moments are private
  unless proposed for the piece; a proposed moment is shared with the next draft revision its
  writer offers, every author must approve it, and editing it afterwards asks everyone to approve
  again. Times are read the same way every time, a malformed one is refused without losing what
  was typed, and every moment keeps a link to the original source, starting at the moment where
  the provider allows it.
- Quotations in moments are now credited the same precise way everywhere in Admin and the combined
  preview: who said the words, the source and the time or page. Choosing a rights status shows plain
  guidance on what that status states, always as your own statement: open.blog does not check
  rights or decide how words may be used. You can add a one-line rights note for your co-authors,
  such as who gave permission, which is never published. A quotation that names no speaker or runs
  past 300 characters gets a gentle warning as you type, and still saves.
- Approved moments are now published with the shared reflection, after everything else under
  "Moments in the sources": where each one is in its source (times read like 1:02), who noted it,
  the quotation in its own language credited to its speaker, source and time, the author's
  observation, and a link that opens a YouTube video at the moment or otherwise links to the original
  source. Nothing is embedded, so a removed or blocked video still leaves the title, the location
  and the link, and a source without a link keeps its location as text. Portable HTML, Markdown and
  text, RSS, JSON Feed and llms-full.txt carry the same moments in order, and an export that would
  drop one is refused. The preview shows each moment exactly as it will be published. Rights
  statements, rights notes and private moments are never published, and pieces without proposed
  moments publish exactly as before.
- Saving a moment in Admin now waits for the save to finish: its buttons are disabled while it is in
  flight, a quick second click no longer collides with the first save, and anything you type while
  it saves is kept instead of cleared.

## [0.30.0] - 2026-10-26

- Defined the reader-facing reference data behind citation previews: each cited reference has a
  stable id (its citation key, distinct per edition), each citation names its marker, note and
  locators, and only the public reference description is included. Posts without published
  citations are unchanged; the page and its notes read the same without JavaScript.
- Pages that publish citations now carry that reference data inline and are easier to navigate
  without JavaScript: the notes are one labelled region, following a citation moves keyboard and
  screen-reader focus to its note, each way back returns to the exact citation (repeated ones
  included), the place you arrive is highlighted, long addresses wrap at high zoom, and print keeps
  every note. If a page's citation links would not match its notes, for example because the post's
  own HTML reuses a generated id, the build stops and names the post. Other pages are unchanged.
- Citation markers now open a preview of the cited source right beside them: on keyboard focus,
  on hover, or on a first tap on touch screens. It shows the formatted reference, the cited
  location and its DOI or web link, closes with Escape (returning focus to the marker) or by
  moving elsewhere, stays on screen at any width, respects reduced motion and is not printed. The
  marker is still the link to its note, nothing is fetched or stored, and only pages with
  published citations load it; without JavaScript the page is unchanged.
- The citation documentation now lists what citation previews guarantee in every release (safe
  links, text-only metadata, the content security policy they need, no requests or storage,
  unchanged reading position, zoom, print and no-JavaScript behaviour, and which outputs never
  carry their data) and what they do not verify: that a source exists or is described correctly,
  that a DOI or address resolves, that a passage supports the claim, or that a source is
  authoritative or may be reused.

### Fixed

- A post that publishes citations and has no `description` no longer takes its description, JSON-LD
  `wordCount` and reading time from the generated notes. They now come from the post's own prose,
  and the space left before a removed citation marker is gone, so "stronger [@plato]." reads
  "stronger." (introduced in 0.27.0). Site search still includes the notes, as it does an author's
  footnotes; a written `description` and posts without citations are unchanged.
- Citation notes now link a DOI stored as `doi:10.x/y` or as a `doi.org` or `dx.doi.org` address
  to `https://doi.org/10.x/y` and show it as `doi:10.x/y`, instead of producing a broken
  `https://doi.org/https://doi.org/...` link (introduced in 0.27.0).
- In a post that publishes citations, a heading named like a generated note or citation id (such
  as `## Cite 1`), or a footnote such as `[^notes]` named like the notes heading, no longer shares
  an id with it, so every in-page link reaches the right place (introduced in 0.27.0). Only the
  generated heading moves aside: the post's own headings keep the ids they have without citations,
  so links to them still work. A post whose own HTML reuses a citation id is still refused, and the
  message now names the id to rename.
- On a site served under a base path (such as `https://example.org/blog/`), text that only reads
  like a redirect address, such as a title or note containing `; url=/x`, is no longer rewritten
  to `; url=/blog/x` on pages, in their structured data or in citation preview data.

## [0.29.0] - 2026-10-26

- Defined the format for a private Knowledge Atlas of people, works, concepts, movements and events,
  with relationships that always name who asserts them, the source evidence and the uncertainty,
  and that never present a contested relationship as consensus. Research-note concept links now
  have a defined home in concept entries; existing notebooks are unchanged. Nothing reads or writes
  an atlas yet, so no site output changes.
- The Knowledge Atlas is now stored privately in `.openblog/private/research/atlas.json` and
  checked by `openblog check`, which also notes approved relationships that stay private
  because an entry they join is private. Withdrawing an entry's approval is never refused,
  events can answer, influence and be influenced, and removing a concept your notes link to is
  allowed and lists those notes. A source or notebook passage the atlas uses cannot be removed
  until the atlas stops using it, and a copy of the atlas inside `content/`, `static/` or a
  theme stops the build and publishing. Nothing from the atlas reaches your site, feeds,
  search, `llms.txt` or exports.
- Admin Studio has a new **Atlas** view under Research tools. You can list, search and filter
  entries by kind, add and edit people, works, concepts, movements and events, and relate them
  with pickers that offer only the entries a relationship kind may join. Each relationship
  names who asserts it, rests on sources from your library (optionally a notebook passage) or
  is marked as an unsourced draft, and records confidence, what is uncertain and who disputes
  it. Each entry lists its incoming and outgoing relationships as text you can move through
  from the keyboard, and a disputed relationship is always shown as contested, never as
  agreed. A note's concepts in the notebook link to their atlas entries. Everything stays
  private.
- You can now publish the approved part of your Knowledge Atlas by setting
  `"knowledgeAtlas": {"publish": true}` in `openblog.json`. The build writes `/atlas/`, a page
  for each approved entry with its relationships from and to it, and the same data as
  `/atlas.json`, built from one projection with a fixed list of public fields. A relationship
  appears only when it and both its entries are approved, always in its stored direction with
  who asserts it, its sources, confidence and doubt, and a disputed one is shown as contested
  with everyone who disagrees. Private entries, notebook passages, unknown fields and anything
  unapproved never appear, clearing an approval removes the item from the next build, and
  sites that leave publication off build exactly as before without reading the atlas.
  Because the atlas is private and Git-ignored, only `openblog serve`, Admin or a local build
  you upload can publish it; `openblog build` and `openblog check` warn when publishing is on
  but no atlas is stored, as in a CI or static-host build.

## [0.28.0] - 2026-10-26

- Shared reflections now work for groups of any size up to the participant cap, through the same
  copy-link invitations. Site owners and coordinators see an audit trail of invitations, joins,
  role changes, and removals (participants and roles only, never links or prose), and role
  changes keep approvals and continuing-conversation attribution in step. Existing records need no
  migration.
- Site owners and coordinators can choose a shared reflection's approval rule in Admin: every
  author, everyone who wrote, the writers plus named people, or the writers plus everyone with a
  chosen role, and whether an approval covers one's own sections or the whole piece. Everyone who
  wrote always approves their own words. Changing the rule needs a confirmation, clears every
  approval, and is refused if someone else changed it first or if the authors could never meet
  it. A coordinator can keep or add people who must approve, but only a site owner can change the
  rule so that someone no longer has to. If a named person leaves, or nobody holds a listed role,
  publishing waits until the rule changes. The combined preview shows the rule. Changing the
  sharing rule now refuses to overwrite a change made elsewhere and, because it clears every
  standing offer, needs a confirmation too.
- A shared reflection with a large group, long names and a long membership history no longer
  risks being saved in a form that could not be opened again; a save that would be too large is
  refused and the reflection stays as it was.
- Accessibility Studio and `openblog check` no longer ask you to review the layout markup of an
  arranged shared reflection as custom raw HTML: it is written by open.blog, with every turn
  under a heading naming its author. Raw HTML anywhere else is still flagged for review.
- When an author removes a part of their draft after the piece was arranged, the combined
  preview says the arrangement no longer matches the drafts, and once every required approval is
  in, publishing asks a coordinator to arrange it again rather than failing with a generic error.
  A coordinator who cannot read the drafts is never told whether a part exists.

## [0.27.0] - 2026-10-25

- Defined how citations work, ahead of in-post citations: a citation is `[@key]` or
  `[@key, page 514; canonical 514a to 520a]`, where the key is a source library id and the
  locators are the notebook's. It is opt-in, so existing posts, links and footnotes render exactly
  as before. Only the key, the locators and the formatted reference can become public, never
  notebook text. CSL import and export now state what is stored, kept as-is, or reported as lost,
  including citation locators. Nothing on your site changes yet.
- You can now insert and edit citations from the Admin Write view. **Cite** searches your source
  library, takes optional locators or copies them from a notebook passage (never its quotation or
  notes), and inserts `[@key, page 514]` only after the server checks it the way a build will read
  it. In Visual mode every citation, including hand-written ones, is a chip that keeps its exact
  Markdown, and Ctrl+Z right after inserting restores the draft and caret exactly. If the library
  changed meanwhile, nothing is inserted and your choices are kept.
- Citations are now found with the same Markdown parser the renderer uses, so code, comments,
  defined `[@label]` links and list continuations are read the same way everywhere. Identifiers in
  private schemes (such as a local file path) and extra fields on notebook locators are never
  published with a citation, and CSL citation items keep custom labels and normalise ids the way
  reference import does.
- Citations typed or pasted in Visual mode now become chips, and a line whose citations the
  visual editor cannot read exactly as a build does (such as one inside link text) is kept
  verbatim instead of being rewritten. Cite refuses a caret inside code or a link in either mode
  and explains why in the still-open dialog. CSL export writes the current `sub-verbo` label.
- Posts can now publish their citations. Add `citations: notes` or `citations: bibliography` to a
  post's front matter and each `[@key, locator]` becomes a numbered note (or a reference list
  entry) built from the source library, in English, German, French or Spanish. The page, portable
  copies, feeds and `llms.txt` all show the same notes, and on the page each marker and note link
  to each other for keyboard and screen-reader users. Only the cited sources' public description
  is published. An unknown key or ambiguous page stops that post with its line and a fix. Posts
  without `citations` are unchanged.
- A draft (or a post waiting for its date) with an unresolved citation no longer stops the build
  or previews of other posts: it gets a warning and keeps the citation as text until it publishes.
  A source library edit that would break a published post's citations is refused and names the
  post and line. `citations: yes` and `on` now work like `true`. **Cite** also refuses a caret
  inside an autolink, indented code, HTML, a comment, or a code span or link that spans lines.
- `openblog check`, builds and Evidence Studio now review a post's citations offline in four
  separate kinds of finding: citations that cannot be read, keys or pages that do not resolve,
  cited sources missing a detail readers need (such as a title, date or journal), and the cited
  locations only you can check against the source. Nothing is looked up online, and no finding
  says whether a source is right or supports a claim. `openblog export <slug> --format
  csl-json` (or `bibtex`) and Evidence Studio's **Download cited references** save a post's
  cited references for reference managers, holding only what its notes show and listing
  anything the format cannot carry.

## [0.26.1] - 2026-10-25

- Two people saving to the same shared reflection at once (drafts, invitations, members, reveal
  and approval changes) are no longer refused now and then with "another content write is
  active": a finished request now releases the content lock before the next one starts.
- On Windows, saves no longer fail with "Access is denied" when another program, such as an
  antivirus or indexing scanner or a backup or sync client, briefly has the file open. Admin and
  CLI writes wait out the hold for up to five seconds, and a compare-and-swap save still refuses,
  rather than overwrites, a file someone changed in the meantime. Reading a shared reflection or
  the login list while it is being replaced waits the same way instead of failing, and a content
  lock file such a program holds is no longer left behind to block later writes.

## [0.26.0] - 2026-10-25

- Feeds and portable copies of a part of a collaborative series now say which series it belongs
  to, where it falls ("Part 2 in the series") and who wrote it, with a link to the series page: in
  the full RSS and JSON Feed content, in portable HTML, Markdown and text, in exports and
  syndicated copies, and in llms-full.txt. RSS items also name the series as a category in the
  site's series taxonomy, and JSON Feed items carry an `_openblog.series` object. Drafts and
  scheduled posts never count, no collaboration details appear, and every other post's feeds and
  copies are unchanged.
- A series that credits the site owner both as the site author and under their contributor entry
  (for example on a shared reflection) now names them once in its list of contributors.
- Portable Markdown now escapes `<` and `&` in titles, names and other facts, so a name such as
  `Kim <https://kim.example>` or `AT&amp;T` stays literal text instead of failing the build.
  Portable Markdown and text of a post with `<` or `&` in its title, credits or other facts change
  once as a result, and so does its portable source revision: renew any portability
  acknowledgements for such posts once in the Admin portable preview.
- A series that holds a collaborative work (a published post credited to two or more authors, such
  as a shared reflection) now says who wrote what. Its page lists the series' contributors, and
  every part, ordinary posts included, shows "By ..." on the series page, inside the previous and
  next links and in the list of all parts. Names come from each post's approved credits and are
  plain text, drafts and scheduled posts never appear, and order and links are unchanged. Every
  other series renders exactly as before.
- A shared publication can now carry a series placement: the same `series` and `seriesOrder` an
  ordinary post uses, so it joins the site's existing series, ordering and navigation. Any one-line
  title works, the placement is part of what every author approves (changing it makes approvals
  out of date), and records without one publish exactly as before. A series' contributors can be
  derived from its posts' work credits.
- The Shared reflections view has a Series panel. Every participant sees the reflection's series,
  position and the reading order it would join; site owners and coordinators choose an existing
  series or type a new title, set or clear the position, preview the order and save; site owners
  can add a new series with its recurring premise. The list and order come from published posts
  only, a change made against an older read is refused without losing what was typed, and the
  combined preview now shows the series and position authors are approving.

## [0.25.0] - 2026-10-25

- You can now archive passages and notes you want out of the way, without deleting them, and export
  and import your private research notebook. Archived entries stay in the file and in exports and
  come back with Show archived or Restore. Export saves one versioned file of all your private
  passages and notes, only when you ask and confirm; import previews first, only adds entries the
  notebook lacks, and refuses any conflict without changing anything. Building, checking and
  publishing now also refuse to continue when a research export or a copy of the notebook has been
  saved into content, static or themes, and automated tests check that private research never
  reaches pages, feeds, search, llms files, portable exports, CSL or BibTeX, logs, error messages or
  published history.
- You can now search the private research notebook and see how it connects. The Notebook view
  filters by source (including its editions and translations), locator kind, concept, and
  question state beside text search, shows each hit with its source, locators and linked notes,
  and lists backlinks for the selected passage, its source and a note's concepts. Questions can
  be marked open or resolved. Everything is computed from the stored files, so it stays correct
  after edits and archiving, and it is private: nothing reaches the public site, feeds or exports.
- Fixed capture edit conflicts: after a conflict you now choose between the stored copy and your
  draft before saving, so a concurrent change is never silently overwritten. Archived sources stay
  selectable on entries that already use them, and stale field errors clear on the next save.
- A source edit or import that would leave the research notebook invalid, such as re-pointing a
  reference so a page locator becomes ambiguous, is now refused with a message naming the affected source (for an import, each record it
  re-pointed or re-typed).
- Notebook search and backlinks now send their text in a request body instead of the URL, so a
  hosting proxy's access log cannot record private research text.

- Defined the private research notebook contract: quoted passages (verbatim excerpt, compound
  page, folio, line, canonical and custom locators, tied to a source-library record) and
  observation or question notes that link to passages, sources, and concepts. Every entry is
  always private with no publication path, quoted text stays apart from your own prose, and a
  failed change leaves the notebook untouched.
- You can now capture passages and notes from Admin. A new Notebook view under Research
  lists, edits and removes them, and a Capture research button in the post editor opens a
  dialog prefilled with your selected text where you pick a source, add locators and an
  optional note, then return to exactly where you were writing. Saving needs a real source and
  the current notebook revision; a stale save keeps your draft and writes nothing. Quoted text
  is stored as typed and shown only as text. The notebook lives in
  `.openblog/private/research/notebook.json`, is kept in the hosted workspace, is checked by
  `openblog check`, and never reaches the built site, feeds, search or exports. A source that
  a passage or note still uses can no longer be removed from the library.

## [0.24.0] - 2026-10-25

- A shared reflection that has both an arrangement and an approved continuing conversation
  publishes the arranged sections in reading order and then the conversation, and every portable
  form (Markdown, text, feeds, llms-full.txt) keeps that order. Approvals bind the arrangement and
  the conversation together.
- Fixed: a link with a username or password in shared prose is refused when publishing, with the
  other unsafe links, instead of failing the whole site build. Syndication plans no longer warn
  about literal raw HTML for a reflection's own layout markup.
- A published shared reflection now reads the same in portable HTML, Markdown, plain text, RSS, JSON
  Feed and llms-full.txt whichever layout it uses: each round prompt, then every turn under its
  author's name and label, in the published order, with no styles, scripts, placeholders or markers
  needed. Portable Markdown and text no longer show the page's layout tags as words, and
  llms-full.txt now keeps prompts, names and labels with their words. The portable HTML check
  reports that column and stagger placement is the one thing a portable copy does not carry.
- Fixed: Markdown typed into a turn label, round prompt or participant name (such as
  `[x](javascript:alert(1))`) could become a live link in the portable Markdown export and could
  break the build. These values now stay plain text everywhere.
- Fixed: in an alternating dialogue the side changes only when the speaker changes, so one author's
  consecutive turns stay on the same side. Point and counterpoint uses two columns only for exactly
  two people and one column for three or more.
- Fixed: a last turn that ends in an indented code block is no longer refused when publishing.
- Shared reflections can also be presented as point and counterpoint, an alternating dialogue or a
  roundtable. A coordinator picks the layout in Admin and can give any turn an optional short label
  (such as "Point"); no label is added for you, and no layout implies that anyone disagrees. The
  roundtable fits any number of participants. Every turn still has its author's name as a heading,
  the page reads in the same order without styles, and wide-screen placement falls back to one
  column on narrow screens, at high zoom and in print. If a contribution is missing or withdrawn,
  its turn and label disappear and the rest read as one honest column.
- Shared reflections can now be presented sequentially or side by side. A coordinator chooses the
  layout and the order of turns in Admin (Shared reflections, "Layout and arrangement"); writers can
  start a new part of their draft with "Start a new part". The published page keeps one reading
  order in the page itself, so a screen reader, print and a page without styles read it top to
  bottom, and side by side becomes one column on narrow screens and at high zoom. Changing the
  layout or the order makes earlier approvals stale, so every author approves what readers will
  see. The part marker line is never shown anywhere.
- Added the layout-independent structure of a shared reflection: rounds, round prompts and turns
  that point at parts of each participant's draft, one deterministic reading order that shows each
  reader only what they may read, and five layout modes over the same contributions without any
  gendered or positional field. Nothing is presented differently yet; invalid structures are
  refused without echoing anyone's text.

## [0.23.0] - 2026-10-25

- The continuing conversation travels with the piece. Full-content RSS, JSON Feed, portable
  HTML, Markdown and text, and llms files keep its categories, attribution, order, open questions
  and stable anchors with a canonical link, and carry no drafting or approval state. An automatic
  summary or excerpt now stops before the conversation, and summary-only feeds export none of it.
- Fixed: the continuing conversation's generated anchors can no longer be claimed by an author's
  own heading, and an item's headings must start at level five and not skip a level. Item saves
  now refuse these (and any heading above level five) up front, and a publish refusal caused by an
  item names the item and the rule instead of blaming a section.
- A published shared reflection now ends with a "Continuing the conversation" section holding its
  approved agreements, differences, questions, applications and uncertainties. Items are grouped by
  kind, each headed "Speaking for" the authors it names, with stable anchors and no consensus signal.
  Only items every named author approved at their current text publish; an empty synthesis adds
  nothing. The combined preview shows the same section, and item Markdown is held to the safety
  rules of sections (no raw HTML or unsafe links, and no headings above level five). It flows into
  RSS, JSON Feed and portable output as ordinary post content.
- Contributors can write, attribute, edit, reorder and approve a shared reflection's continuing
  conversation in Admin: optional agreements, differences, questions, applications and
  uncertainties, with dismissible, editable prompts and no minimum length. Each item shows who has
  approved it, in Admin and in the combined preview (editors and coordinators never see items). Publishing is blocked while a named author has
  not approved the piece or any item is awaiting approval, and any change to an item makes standing
  approvals of the piece out of date. Items stay private to the authors; nothing is published yet.
- Shared reflections have a core model for synthesis items: optional agreements, differences,
  questions, applications and uncertainties, each attributed to one, some or all authors. Disagreement
  is never an error, authors can withdraw their own name, and an approval binds to the exact items,
  order and attribution. Each item records which of its authors approved it, and any change to the
  item clears those approvals. No Admin screen or public output uses it yet.

## [0.22.0] - 2026-10-25

- Portable Markdown for a published shared reflection now escapes its title, so a participant-supplied
  title can no longer inject raw HTML into an export or syndicated copy.
- A published shared reflection now has checked output everywhere the site publishes: the page,
  portable HTML and Markdown, RSS and JSON Feed show every author's section in order, credit each
  author who wrote one in the same order, and link the shared source and guiding question. Replaced
  draft revisions, invitations, approvals and account names never appear in any of them.
- Shared reflections can now be approved, scheduled and published (routes only; the Admin screens
  come later). An author approves the exact piece they read, a coordinator or site owner publishes
  it only while every required author's approval still matches, and a missing or stale approval
  refuses the request with nothing written. Publishing writes the Post, its credits and the
  rebuilt site as one unit and is undone if any step fails; repeating it changes nothing. A
  scheduled reflection is held privately and checked again when its time comes, so an edit or a
  removal after scheduling holds it back. Sections with raw HTML or `javascript:` style links are
  refused, and refusals never repeat anyone's text. The check covers the combined page, so heading
  attributes, math-style `$...$` markup, and an unclosed code fence or link definition in one
  section that would change another author's section are refused too.
- Added the approval model for shared reflections: an approval is an author's own affirmative,
  timestamped consent bound to the exact content, author set, order, public metadata and policy,
  so editing or changing any of them withdraws the affected approvals and nobody can approve for
  another author. No screen or publishing step uses it yet.
- An approval from an author who has written no section now covers the whole piece, so any
  later edit to the prose withdraws it.
- Added a combined preview to Shared reflections in Admin ("Review the combined piece"). It shows
  every author's section together at its exact current revision with each author's approval (approved,
  awaiting, or out of date), and is clearly marked "Preview, not published". You see a section only
  when it is shared with you at its current revision; anything else is one placeholder. The preview
  runs no script, loads no images, and changes nothing. It renders prose with the site's own
  Markdown settings, and an author who has written nothing no longer stops the others from
  reviewing and approving the piece.

## [0.21.1] - 2026-10-25

- Fixed voluntary reveal so a publication keeps one author set: visibility is now derived from the
  active participants' standing ready offers, so late joiners see earlier offers and are seen in
  return, each person sees only the revision currently offered, and removed or withdrawn people are
  excluded both ways and rejoin when restored. Reveals made by the all-ready rule, explicit
  exchanges and data stored by v0.21.0 keep their meaning.

## [0.21.0] - 2026-10-25

- Fixed the shared draft sharing controls: the revision you confirm to share is now always the one
  sent, even if the draft changes in another tab, and keyboard focus stays in the Sharing section
  after you offer, take back or change the rule.
- Added a "Your draft" panel to Shared reflections in Admin. Writers get optional prompts they can
  add, edit, delete or hide, a clear saved or unsaved state, and sharing controls to offer a
  revision or take the offer back. If a draft changed in another tab, your text stays put beside the
  newer copy and you choose which to keep, with an undo. Offline and size errors keep your text.
  Other people's drafts appear only once the sharing rule has revealed them to you.
- Added optional mutual reveal for shared reflections. A coordinator chooses whether sharing is off
  (the default), voluntary, or requires everyone to be ready. Each contributor marks one exact
  revision ready and can take it back until the reveal happens; then everyone involved sees those
  revisions together. A comparison lists everyone in order by name and shows a placeholder for any
  section not revealed to you. Changing the policy never reveals anything, and removed members
  neither block nor receive a reveal.
- Added private draft saving for shared reflections: a Contributor or Editor can save and read only
  their own section through Admin. Each save appends a revision; a save made on an out-of-date
  copy is refused with the newer copy and overwrites nothing. Drafts stay under the project's
  private folder and never reach content, generated output, feeds, exports or Git.
- A shared draft that reaches its revision or storage limit is now refused with a clear message
  and nothing is lost, instead of making every participant's drafts unreadable.
- Defined private contribution drafts for shared reflections: append-only revisions with a
  prose-free identity, conflict checks on save, and a mutual reveal that shows nothing until every
  member has committed. Revealing is never approval, and no storage or route is added yet. Draft ids are compared ignoring case so a stored set always
  reloads, and saving over another participant's draft id no longer reveals more than that the id
  is taken.

## [0.20.0] - 2026-10-25

- Enforced collaboration roles through one server-side check on the shared reflection record.
  Readers, editors, and contributors cannot invite or manage invitations, accounts that were
  disabled or removed lose every grant at once, and operations without a route stay denied. Site
  ownership alone cannot publish a reflection until each contributor has approved the current
  revision.
- Added invitations to shared reflections in Admin Studio. A site owner or coordinator names an
  existing Admin account, the contributor profile it will appear as, and roles, and gets a private
  link to pass on; nothing is emailed. The link works once, only for that account, expires in 1 to
  30 days, and is stored only as a hash. The invitee accepts or declines after signing in; wrong
  accounts, spent, expired, revoked, and guessed links all fail the same way, and repeated guesses
  are rate limited. Owners and coordinators can revoke a link or issue a new one. The Admin API
  adds `/admin/api/collaboration/invitations` (list, create, revoke, reissue, accept, decline).

- Added member management to shared reflections in Admin Studio. Site owners and coordinators see
  who can sign in, their roles, pending and finished invitations, and warnings when an account or
  profile no longer exists. They can change roles, remove access, and revoke links, each after an
  explanation of what changes. Ending access never removes credit for what someone wrote. A change
  made on a stale view is refused and the list reloads, and the last site owner cannot be removed.
  The Admin API adds `GET /admin/api/collaboration/members` and `POST .../members/roles` and
  `.../members/remove`.

## [0.19.0] - 2026-10-25

- Added import and export to Sources in Admin Studio. Import CSL JSON (for example from
  Zotero) after a preview of what would be created, updated, kept, and not imported; conflicts
  such as duplicate ids or identifiers block the whole import and nothing is saved, and
  re-importing the same file changes nothing and never discards richer details you already
  recorded. Private notes and abstracts are never imported. Export CSL JSON (lossless for
  open.blog) or BibTeX (with a list of what it cannot carry). The Admin API adds
  `POST /admin/api/sources/import` and `GET /admin/api/sources/export`.
  Re-imported items may state only the fields they change, an import can no longer give two
  sources the same DOI, ISBN, ISSN, PMID, or PMCID (including through an update), hand-edited
  files cannot slip private notes through `custom`, and BibTeX export stays valid when a title
  holds a lone brace.
- Included the research source library in the durable hosted editorial workspace so source
  changes made in Admin survive a Render restart or redeploy.
- Defined the versioned research source library contract in core: distinct works, editions,
  translations, witnesses, and references with stable identifiers, source locations, lossless
  unknown fields, and source-scoped diagnostics that keep contributor credits out of
  bibliography.
- Stored the research source library privately at `.openblog/private/research/sources.json`
  with revision-checked, locked, atomic create, update, and remove. Stale revisions,
  duplicate or missing ids, symlinked paths, and malformed, oversized, or newer-version
  files are refused with source-scoped diagnostics and leave the stored file unchanged, and
  interrupted writes are cleaned up. `openblog check` validates a stored library.
- Added Sources to Admin Studio for managing the private research source library: create,
  edit, archive, restore, search, and filter works, editions, translations, witnesses, and
  references with type-aware fields. Stale edits report a conflict and keep your draft
  without overwriting newer data, failures name the source and field and leave the stored
  library unchanged, and archived sources stay in place so records that point at them still
  resolve. The Admin API is `/admin/api/sources`.
- Builds no longer copy anything inside `.openblog/` when a static or theme directory
  contains it or a static file links into it.

## [0.18.0] - 2026-10-25

- Fixed a guiding question or source title containing a tilde pair, such as `~this~`, stopping the site build and Admin preview; the text now exports literally.
- Posts can now publish the source of a shared reflection. `guidingQuestion`, `sharedSourceTitle`,
  `sharedSourceUrl`, and `sharedSourceType` in front matter show the guiding question and the
  original source's title, link, and type beside the work, in Admin preview, the built page, RSS,
  JSON Feed, `llms-full.txt`, and portable HTML, Markdown, and text. The source is always a plain
  link, so an unsupported provider degrades to the link. Only these four values are published;
  invitations, drafts, participants, and other collaboration state never reach output. An unsafe
  link, a bad type, or oversized text stops the build with a clear message instead of publishing.
- Added an optional **Suggest details from link** button to each source in a shared reflection.
  For YouTube and CodePen links, the same providers the embed renderer supports, Admin Studio asks
  the provider's oEmbed service for a title and creator and fills only fields you left empty,
  telling you what it filled. It never fetches transcripts or pages, refuses redirects and
  non-public addresses, and gives up after six seconds. A timeout, refusal, missing details, or an
  unsupported link changes nothing and never blocks saving. Nothing is stored until you create the
  reflection. Suggested fields carry a "Suggested by" note until you edit them, and an answer that
  arrives after you changed the link or removed the source is discarded.
- Added a versioned, group-safe collaboration contract in `openblog-core` with ordered
  participant, contribution, reveal, layout, and approval collections, explicit size limits, a
  derived two-person projection, revision-checked replacement, and one non-identifying error for
  unsafe identifiers, spoofed names, profile URLs, Markdown, or unknown fields.
- Defined shared-publication language for sources, participants, collaboration roles,
  contribution drafts, reveals, approvals, and published assemblies, kept apart from posts,
  contributors, work credits, and Admin users, with fixtures for legacy posts and groups of any size.
- Added a publication-scoped collaboration authorization policy that binds an Admin user and a
  contributor registry key to one participant. Site owner, coordinator, contributor, editor, and
  reader roles are explicit. Access is denied by default, checked against the draft's owner and
  reveal list from the contract, and creates no authorship, credit, or approval. Changing a
  binding or its roles is itself authorized: only a site owner can grant or revoke the site owner
  role, and the last site owner cannot be removed. Admin usernames and binding names now share
  one validation rule.
- Added **Content → Shared reflections** to Admin Studio: start a private shared reflection from
  a video, article, podcast, book, or other source, with or without a link, plus a working title
  or guiding question, using labelled fields and examples instead of Markdown. Each one is stored
  atomically as a versioned private record outside `content/` with ordered source references,
  normalized HTTP(S) links, and the creator bound as site owner. Unsafe links, unknown fields, and
  identity claims in the request are refused without echoing them, and no post, credit, build, or
  feed changes.
- Added a View publication collaboration action, listed shared reflections only to bound
  participants, and removed an account's bindings when `openblog user remove` or
  `openblog user add` reuses its name. Contributors bound to a shared reflection can no longer be
  removed from the registry.

## [0.17.2] - 2026-10-24

- Web sandbox HTML, CSS, and JavaScript editors and configured-runner lessons now use the same
  editable-code surface as Rust playgrounds: a labelled editor bar, syntax colouring and optional
  line numbers from the static code blocks, the same focus ring, and matching Run, Reset, and note
  styling. Existing `ob-rust-*`, `ob-code-runner-*`, and `ob-web-sandbox-*` classes remain on the
  elements for theme overrides; shared styles now live on `ob-code-editor-*` classes.
- Fixed sites built without a local `web/` folder missing the configured code-runner scripts;
  the absent module stopped every enhanced component on the page from loading. A test now
  checks that every relative script import is embedded.

## [0.17.1] - 2026-10-24

- Added modern Supabase secret API key support for Netlify comments and analytics via
  `SUPABASE_SECRET_KEY`, while preserving legacy service-role authentication and documenting
  the server-only setup without a database migration.

## [0.17.0] - 2026-10-24

- Added an optional post `subtitle` (also `subheading` or `dek`) shown under the title, edited directly
  beneath the title in Admin Studio, imported from and sent to Hashnode, and kept separate from the
  search `description`. JSON-LD carries it as `alternativeHeadline`, and subtitles over 160 characters are
  flagged in Admin readiness and as a build warning. Re-running the Hashnode import reports posts that have a
  Hashnode subtitle as changed; overwriting them adds `subtitle`, which marks them for re-syndication.

## [0.16.0] - 2026-10-24

- Portable HTML now renders static fallbacks for every current interactive capability:
  quizzes keep their prompt, lettered choices, and the author's answer and explanation behind a
  native `<details>` disclosure; runnable code and web sandboxes keep their labelled source with
  a link to run them on the canonical article; CodePen and YouTube embeds become titled provider
  links; video chapters become an ordered chapter list; recipe facts, callout titles, and
  video production notes stay visible; and comments become a link to the canonical discussion.
  The output needs no open.blog script, custom element, form, or iframe.
- Portable HTML now keeps research and attribution: ordered contributor credits with their roles
  and unauthenticated ORCID iDs (kept apart from the references), the DOI and license, the
  "Originally published at" source, and footnote citations that keep their numbers and ids and
  link to the note on the canonical article. Planned or unknown capabilities fail closed: their
  authored content stays visible with a labeled link to the canonical article and a
  canonical-only report, while private-only state adds nothing to the copy or its report.
- Portable HTML now rewrites authored raw HTML through a documented allowlist: scripts, styles,
  event handlers, forms, `<base>` and `<meta>` tags, comments, and custom elements are removed
  or unwrapped (Markdown inside a removed element goes with it); frames, media, SVG, and MathML
  become a link to the canonical article; heading `{key=value}` attributes are dropped; and each
  removal is reported as a `raw-html` capability. Raw HTML URLs resolve against the canonical
  article like Markdown links, ids stay unique across raw HTML, headings, and footnotes, every
  image gets `alt`, and the body stays well nested. Native pages are unchanged.
- The portable projection fails for that post with a source-scoped diagnostic, instead of
  publishing or truncating, when a raw HTML or `sourceUrl` address is unsafe (including `data:`
  and encoded `javascript:` URLs), a removed element or comment that is never closed would hide
  later content, or the body exceeds 2 MiB or 64 levels of nesting.
- Fixed quizzes and web sandboxes failing to build when nested in a callout, quote, or list item.

## [0.15.0] - 2026-10-24

- Added private per-admin workspace personalization to Admin Studio: Simple (the new default),
  Guided, Advanced, and Custom presets; showing, hiding, and reordering optional tools; comfortable
  or compact density; a default Visual or Markdown writing mode; and Restore defaults. A
  goal-grouped **Advanced tools** dialog, the **More tools** menu, and `Ctrl+K` keep every tool
  reachable in every preset, and Write, Site preview, Settings, save and publish state, conflicts,
  privacy notices, approvals, and blocking validation can never be hidden or reordered.
- Stored workspace preferences as a bounded, schema-versioned file per login under
  `.openblog/private/admin-preferences/`, behind login and CSRF checks, with atomic,
  revision-checked saves so a change from another tab is reloaded instead of overwritten. They never
  reach posts, `openblog.json`, the built site, feeds, or exports, and unavailable storage falls back
  to a usable Simple workspace with a notice.
- Admins whose browser remembered a writing mode from an earlier release move once into the
  Advanced layout with that mode; every other login, including others in the same browser, starts
  in Simple.

## [0.14.0] - 2026-10-24

- Defined the semantic portability invariant and domain language for derived output,
  destination policies, private/public boundaries, and canonical work identity.
- Added core descriptors for authored Markdown capabilities, including renderer,
  fallback, portability, and bounded diagnostics, without changing authoring syntax.
- Added a destination-neutral projection for canonical identity, existing HTML,
  Markdown, and text views, authorship, references, capabilities, and safe links;
  routed public feeds and syndication through it without changing authored content.
- Added a shared portability fixture corpus covering legacy articles, research and
  credits, recipes, callouts, media, quizzes, runnable code, unknown syntax, hostile
  code, Unicode, duplicate anchors, and draft exclusion.
- Published an implementation-status matrix separating shipped capabilities,
  partial support, and planned work without assigning unverified portability levels.
- Audited generated native HTML and optional custom elements, documenting no-JavaScript
  and no-CSS behavior, accessibility caveats, and the raw-HTML trust boundary.
- Audited semantic differences across Markdown, native pages, feeds, and syndication;
  extended shared fixtures across these output surfaces and documented known losses.
- Defined portability completion gates for planned research, reader, collaboration, and
  discovery capabilities, with unique story/task ownership and machine-checked fallbacks,
  privacy boundaries, and regression requirements.
- Added an opt-in portable HTML body projection that re-renders canonical Markdown, resolves
  authored link and image URLs against the post/site context, and leaves existing native HTML
  unchanged; raw-HTML sanitization and capability-specific fallbacks remain separately scoped.

## [0.13.0] - 2026-10-24

- Added `openblog syndicate <slug>` with dry-run planning, draft-first DEV, Hashnode,
  Ghost, and WordPress adapters, guided Medium import, private remote-ID state, and
  explicit two-step publication safety.
- Added optional provider-neutral code-runner configuration for credential-free, explicitly
  allowlisted executable lessons while preserving the official Rust Playground default and static
  fallback for unsupported languages.
- Expanded Assistant Interactions to propose strictly validated Rust, web, and configured-runner
  examples or coding challenges without executing code in the blog or Admin process.
- Added dependency-free `web runnable` HTML/CSS/JavaScript sandboxes with editable tabs and a
  CSP-restricted opaque-origin preview.
- Added structured video production stages, season/episode numbers, credits, an Admin workflow,
  and a complete fictional Zhalendor example production post.
- Added per-post open, locked, and hidden comment policies plus pending, approved, and rejected
  Admin moderation queues.
- Added optional Supabase-backed Netlify Functions for moderated comments and persistent,
  privacy-respecting view analytics, with a checked-in SQL schema and deployment guide.
- Added hosted engagement settings and pending-comment moderation to Admin Analytics. Public
  endpoints live in `openblog.json`; the matching Admin token is write-only, privately protected,
  bound to its endpoint origin, and can be overridden with `OPENBLOG_ENGAGEMENT_API_KEY` plus
  `OPENBLOG_ENGAGEMENT_API_ORIGIN`. Admin requests reject redirects and public writes use
  Supabase-backed per-client and per-site quotas.
- Expanded Assistant Interactions with editable runnable Rust examples and bounded coding challenges,
  including selected-section grounding, visible TODO and expected-result requirements, explicit
  insertion in Visual or Markdown mode, and a non-AI authoring path.
- Updated the Learning design review skill and versioned publishing-engine guide so recommendations
  distinguish recall checks, exploratory examples, and guided coding practice without inventing
  unsupported languages, multi-file projects, hidden tests, or automatic grading.

## [0.12.0] - 2026-10-24

- Added native Assistant integrations for OpenAI, Google Gemini, xAI Grok, DeepSeek, Mistral AI,
  and OpenRouter with fixed official destinations, provider-specific environment credentials,
  structured-output adapters, editable model choices, and strict local result validation.
- Added a versioned publishing-engine guide to Assistant requests so reviews, quiz proposals, and
  autocomplete understand native open.blog syntax, profiles, scheduling, and source boundaries.
- Added safe local application and one-step undo for exact AI review suggestions, with Unicode range
  handling and fail-closed stale, ambiguous, repeated, and overlapping edit detection.
- Added session-only opt-in AI autocomplete for Visual and Markdown writing, with explicit data
  disclosure, debouncing, selected context, stale-response suppression, abort-on-navigation, and
  author-controlled accept or dismiss actions.
- Completed Assistant Interactions by connecting it to the reviewed knowledge-check proposal flow.
- Added a CI-enforced documentation link and heading-anchor check, and expanded the documentation
  index and project overview to cover the completed author-time Assistant workflows.

## [0.11.2] - 2026-10-23

- Grounded Assistant reviews in trusted open.blog renderer capabilities so native quiz and
  runnable Rust fences are reviewed for authoring quality without being misreported as unsupported.

## [0.11.1] - 2026-10-23

- Made review verification labels context-aware and conservatively downgraded unsupported
  `supplied-context` claims to unverified advice instead of discarding an otherwise valid review.
- Extended native Anthropic Assistant requests to four minutes while preserving the existing
  30-second custom-provider deadline, allowing first-use structured-output grammar compilation.
- Constrained native Anthropic Assistant replies with task-specific JSON schemas so every review
  finding includes its required source range, and safely re-anchors incorrect provider offsets
  when their exact evidence occurs only once in the reviewed Markdown.
- Fixed Anthropic reviews that could spend the entire output budget on adaptive thinking before
  returning JSON, and now report safe, actionable stop-reason errors for empty responses.
- Added native Anthropic Claude support with the correct Messages API authentication and response
  adapter, plus an author-friendly provider choice that keeps custom HTTPS integrations compatible.
- Added an Assistant provider settings panel for endpoint and model configuration plus write-only
  private credential replacement and clearing, with environment credentials taking precedence.
- Refined Assistant provider setup into a compact connection card with clear status, progressive
  disclosure, author-friendly guidance, and confirmed credential removal.

## [0.11.0] - 2026-10-23

### Added

- Added a post Assistant workspace with keyboard and command-palette navigation, labelled
  Review, Interactions, and Context areas, and an authenticated credential-safe provider
  capability summary that leaves non-AI authoring available when configuration is missing.
- Added portable and private author/site Assistant context management with bounded UTF-8 files,
  atomic conflict-safe saves, Git safety warnings, publish exclusions, and a selected-context
  disclosure preview.
- Added portable and private post briefs, bounded Markdown/text references, and immutable existing-
  post snapshots to Assistant context, including transactional post rename and deletion handling.
- Added explicit URL-context snapshots with inspect-before-save metadata, selectable portable or
  private storage, SSRF-safe DNS and redirect validation, and bounded textual extraction without
  implicit refetching.
- Added seven inspectable, non-executable Markdown review skills plus validated project skills,
  explicit built-in overrides, repair guidance, and conflict-safe editing.
- Added document review over the current unsaved draft with selected skills and context, strict
  all-or-nothing structured findings, source anchoring, provider disclosure, and clearly labelled
  AI advice that never edits or saves the draft automatically.
- Added Visual and Markdown writing modes in Admin, with a remembered author preference,
  Heading 2–6 selection, familiar rich-text controls, and protected advanced blocks that
  retain source the visual editor cannot safely represent.

- Added a Field journal content profile for hikes and other place-based notes, with field
  facts, route and elevation drawings, structured place metadata, and hidden-by-default
  location handling.
- Added an Admin Field Review workflow that analyzes GPX locally, derives deterministic
  measurements, trims endpoints, and uploads source tracks only when Exact mode is chosen.

- Added a Video production content profile with privacy-enhanced YouTube embeds, duration
  and thumbnail metadata, creator-authored AI-assistance disclosure, and `VideoObject`
  structured data.
- Added an Admin release kit that extracts timestamp lines from Markdown, validates YouTube
  chapter rules, and composes a copy-ready description from the current draft.

## [0.10.1] - 2026-10-23

### Added

- Added a runnable research and contributor-credit demonstration to the repository example
  site, with synthetic registry identities, ordered Crossref/CRediT roles, an adjacent credit
  sidecar, visible references, a reusable license, feeds, and scholarly structured data.

### Changed

- Linked the README and authoring documentation directly to the example's configuration,
  Markdown, and sidecar files, with commands for inspecting them in Admin Studio or a build.

## [0.10.0] - 2026-10-23

### Added

- Added a stable contributor registry with public profile links, normalized manually entered
  ORCID identifiers, `sameAs` identities, and explicit provenance boundaries that avoid
  presenting editable identity data as authenticated.
- Added versioned per-post credit sidecars with ordered contributors and controlled
  Crossref/CRediT roles, including explicit-empty credits and legacy site-author inheritance.
- Added Admin Studio tools for managing contributor identities and per-post credits with
  conflict detection, reference-aware deletion, repair states, and source-preserving saves.
- Added `openblog contributors migrate --id <stable-id>` with a dry-run default and explicit
  `--write` mode for safely converting inherited authorship to reusable contributor credits.

### Changed

- Published bylines, article JSON-LD (including recipe posts), RSS, JSON Feed, and research
  metadata now use the resolved ordered contributor credits while preserving legacy author
  behavior for existing sites.
- Admin and CLI content writes, imports, migrations, and publishing now share a filesystem
  transaction lock so configuration and credit sidecars cannot be published half-written.
- Document listing, preview, save, delete, and validation now understand adjacent
  credit sidecars and surface malformed, orphaned, or ambiguous ownership errors.

## [0.9.0] - 2026-10-23

### Added

- Added the opt-in `research` content profile with DOI and license authoring fields, visible
  work metadata, ordinary-Markdown Abstract and References/Bibliography sections, and
  bounded reference extraction.
- Added deterministic evidence findings shared by `openblog check`, builds, and admin
  previews for research structure, DOI and license syntax, footnotes, reference links, and
  preferred DOI resolver links.
- Added `ScholarlyArticle` JSON-LD and conservative Highwire title, author, and publication
  date metadata, while omitting unsupported venue, publisher, review, and indexing claims.
- Added Evidence Studio with current-document findings, normalized work-metadata inspection,
  engine-backed Abstract/References insertion actions, dynamic profile fields, and `Alt+7`.

### Changed

- Build reports and `openblog check` now print evidence findings with stable codes, outcomes,
  source locations, and repair guidance separately from accessibility and SEO guidance.
- Profile-specific editor drafts now survive profile switches and save losslessly, including
  explicit field clears.

## [0.8.0] - 2026-10-23

### Added

- Added one structured accessibility audit shared by the core engine, `openblog check`,
  builds, and the admin preview. Findings use stable codes, canonical source locations,
  outcome labels, repair guidance, and informative standards references where applicable.
- Added bounded source checks for empty link names, missing site language, image
  alternatives, heading jumps, generic link text, tables, media, production embeds, and
  raw HTML without presenting context-dependent concerns as certain failures.
- Added a dedicated Accessibility Studio editor view with outcome counts, grouped findings,
  exact source context, next actions, and rendered-site manual-review guidance. It is
  available from normal editor navigation and `Alt+6`.

### Changed

- Build and check output now reports accessibility findings separately from publishing and
  SEO warnings. The accessibility reporter adds no pass or WCAG-conformance statement when
  its finding list is empty.
- Admin previews return only site-wide findings and findings for the document being edited,
  so another post's guidance cannot leak into the current workflow.

## [0.7.0] - 2026-10-23

### Added

- Added a content-profile catalog shared by the publishing engine and admin, beginning
  with the general-purpose `article` profile and the structured `recipe` profile.
- Added a Content profile selector to post settings, including visible fallback guidance
  for unknown profile ids and structured authoring-field metadata for future profiles.

### Changed

- Made `profile: recipe` the canonical way to select recipe behavior while retaining
  byte-for-byte generated-output compatibility with `recipe: true` and the existing
  `type`, `layout`, and `kind` recipe aliases.
- Unknown profile ids now round-trip without data loss, render safely as articles, and
  produce source-scoped build and preview warnings. A canonical `profile` takes precedence
  over contradictory legacy recipe markers and reports the conflict.

## [0.6.2] - 2026-10-23

### Changed

- Updated the project overview and documentation index to describe the focused writing
  workspace, publishing-faithful theme preview, social cards, readiness guidance, and
  source-preserving editing added in 0.6.0.
- Documented post, series, and site theme precedence with a practical pre-publish testing
  workflow, plus troubleshooting for base-path stylesheet MIME errors and the expected
  signed-out session probe.

## [0.6.1] - 2026-10-23

### Fixed

- Served the admin shell's root-relative theme and base styles from the built site when a
  configured deployment base path is active, preventing HTML fallback responses and strict
  MIME-type stylesheet failures during local administration.

## [0.6.0] - 2026-10-23

### Added

- Production-faithful draft previews that use the same site model, theme inheritance,
  renderer, metadata, and components as a published build while keeping front matter hidden.
- A dedicated social-card view backed by the exact resolved OpenGraph and X metadata emitted
  by the renderer, including canonical and site-image fallbacks.
- A transparent SEO and answer-readiness workspace with grouped search, answer-structure,
  trust, accessibility, and source-link guidance.
- Source-preserving Markdown controls for headings, emphasis, links, quotes, lists, and code,
  including keyboard shortcuts and undo-aware editing.

### Changed

- Replaced the permanent side-by-side editor with focused full-width Write, Site preview,
  Social, Optimize, and Settings views.
- Deferred expensive publishing-engine previews until Site preview or Social is visible and
  prevented stale asynchronous responses from replacing newer drafts.
- Hardened unpublished previews with authenticated random URLs, a bounded in-memory cache,
  opaque-origin sandboxing, restricted script origins, and disabled snippets and analytics.

## [0.5.0] - 2026-10-23

### Changed

- Reworked the admin into a publishing workspace with grouped tools, a persistent
  publish-status bar, labeled settings/Markdown/preview panes, and an explicit
  mobile pane switcher inspired by the README Studio workspace pattern.
- Added a `Ctrl/Cmd+K` workspace search for navigation, creation, account actions,
  and contextual editor commands, with keyboard result navigation and unsaved-change
  protection when moving between admin views.
- Added editor save-state feedback, live line/word/character counts, `Alt+1/2/3`
  pane focus shortcuts, and persistent wide/tablet/mobile preview widths.
- Added an admin overview with publishing-pipeline totals, quick-create actions,
  content inventory, recent posts, scheduled-post context, and build health.

## [0.4.1] - 2026-10-23

### Added

- A reader-facing guide to safely syndicating open.blog articles to Hashnode, DEV,
  Medium, Ghost, WordPress.com, and self-hosted WordPress.
- A deploy-gated GitHub Actions template and dependency-free DEV adapter that create
  drafts, verify canonical URLs, and update existing articles without duplicating them.

### Changed

- Expanded the starter Getting Started series with a cross-posting walkthrough and
  documented feed, credential, canonical URL, and platform-specific safety requirements.

## [0.4.0] - 2026-10-22

### Added

- Opt-in editor-style Rust examples with syntax colouring, line decorations, inline
  compiler/program output through the official Rust Playground, reset, copy, an optional
  external fallback, a privacy notice, and a no-JavaScript code-block fallback.

## [0.3.0] - 2026-10-22

### Added

- Live search and answer-readiness guidance in the author editor, with the
  same checks available during site builds.
- `llms.txt` and `llms-full.txt` discovery files for AI assistants and answer
  engines.
- Structured author identity, author profile links, richer Open Graph data,
  and Twitter card metadata.
- Privacy-preserving analytics for AI crawler and agent traffic, including
  aggregate provider totals and requested-page breakdowns.
- Independent controls for AI search discovery and AI model-training crawlers.
- An SEO and answer-engine optimization guide for blog authors and operators.

### Changed

- Expanded generated metadata and feeds so posts are easier for search
  engines, answer engines, and social platforms to understand and attribute.
- Updated the starter configuration and documentation for the new SEO,
  author-identity, crawler-policy, and analytics capabilities.

## [0.2.0] - 2026-10-22

### Added

- Interactive Markdown knowledge checks with immediate accessible feedback,
  retry support, and attempts stored only in the reader's browser.
- An admin knowledge-check builder for one to three questions, with editable
  manual entry and optional author-time generation through an owner-configured
  API endpoint and key.
- A sample knowledge check in the starter “Writing a post” article.
- Persistent light and dark modes for the redesigned admin interface.
- Domain documentation, an architectural decision record, and automated
  coverage for quiz rendering, interaction, validation, and provider failures.

### Changed

- Refined the admin navigation, editor, content tables, analytics, dialogs,
  responsive layout, keyboard focus, and visual hierarchy.
- CI now discovers every JavaScript test in `tests/web/`.

[Unreleased]: https://github.com/journey-to-code-org/open.blog/compare/v0.17.0...HEAD
[0.17.0]: https://github.com/journey-to-code-org/open.blog/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/journey-to-code-org/open.blog/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/journey-to-code-org/open.blog/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/journey-to-code-org/open.blog/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/journey-to-code-org/open.blog/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/journey-to-code-org/open.blog/compare/v0.11.2...v0.12.0
[0.11.2]: https://github.com/journey-to-code-org/open.blog/compare/v0.11.1...v0.11.2
[0.11.1]: https://github.com/journey-to-code-org/open.blog/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/journey-to-code-org/open.blog/compare/v0.10.1...v0.11.0
[0.10.1]: https://github.com/journey-to-code-org/open.blog/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/journey-to-code-org/open.blog/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/journey-to-code-org/open.blog/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/journey-to-code-org/open.blog/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/journey-to-code-org/open.blog/compare/v0.6.2...v0.7.0
[0.6.2]: https://github.com/journey-to-code-org/open.blog/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/journey-to-code-org/open.blog/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/journey-to-code-org/open.blog/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/journey-to-code-org/open.blog/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/journey-to-code-org/open.blog/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/journey-to-code-org/open.blog/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/journey-to-code-org/open.blog/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/journey-to-code-org/open.blog/releases/tag/v0.2.0
