# Netlify hosted engagement

This function provides moderated comments and persistent analytics for a static open.blog site.
Supabase is accessed only from the function; never put its secret key in `openblog.json` or a
browser script.

## Setup

1. Create a Supabase project and run [`supabase/openblog.sql`](../../supabase/openblog.sql) in its
   SQL editor.
2. In Netlify, open **Site configuration → Environment variables** and set:

   | Variable | Value |
   | --- | --- |
   | `SUPABASE_URL` | Project URL from Supabase API settings |
   | `SUPABASE_SECRET_KEY` | Supabase secret API key (`sb_secret_...`); server-only |
   | `OPENBLOG_SITE_ID` | Stable identifier such as `lantern-studios` |
   | `OPENBLOG_SITE_ORIGIN` | Exact public origin, such as `https://blog.example.com` |
   | `OPENBLOG_ADMIN_API_KEY` | Long random token used for moderation and Admin analytics |
   | `OPENBLOG_ANALYTICS_SALT` | Separate long random value used only to hash daily visitors |
   | `OPENBLOG_SITE_BASE_PATH` | Optional public base path such as `/blog/`; defaults to `/` |

   Find the secret key under **Supabase project settings → API Keys → Publishable and secret API keys**.
   Neither `SUPABASE_PUBLISHABLE_KEY` nor `SUPABASE_JWKS_URL` is needed by this integration.
   Secret keys are sent in the `apikey` header, not as bearer JWTs. Existing deployments may keep
   `SUPABASE_SERVICE_ROLE_KEY` as a fallback; `SUPABASE_SECRET_KEY` takes precedence when both are
   set. Legacy JWT keys retain their bearer authentication. No SQL migration is required: both
   server key types use the database's `service_role` permissions.

3. Deploy (or redeploy after changing environment variables). `netlify.toml` maps the public and Admin API routes to the function.
4. Run `openblog serve --admin`, open **Analytics**, enable hosted engagement, and set the endpoint
   to `https://your-site.example/api`. Enter the same value as `OPENBLOG_ADMIN_API_KEY` in the
   write-only moderation token field. The Admin copy stays in `.openblog/private` and is never
   committed or returned after saving. If you instead set `OPENBLOG_ENGAGEMENT_API_KEY` on the
   machine running Admin, also set `OPENBLOG_ENGAGEMENT_API_ORIGIN` to the exact endpoint origin;
   this binding prevents the token from being sent to a changed destination.

New comments remain pending until approved in **Admin → Moderation inbox** (see
[Moderation inbox](#moderation-inbox) below). To keep bots out of that queue, optionally add a
captcha: see [Comment captcha](#comment-captcha-optional) for its five variables. For every
public comment read or submission, the function fetches the generated `openblog-comments.json`
manifest from `OPENBLOG_SITE_ORIGIN` and enforces its open, locked, or hidden policy before querying Supabase.
Keep that origin current and publicly reachable. Public pages never receive any Supabase key or the
moderation token. Supabase-backed hourly quotas limit comment submissions and analytics writes
before content is stored.

## Comment captcha (optional)

A Cloudflare Turnstile challenge before the first comment of a visit keeps bots out of the
moderation queue. It is off unless you turn it on in two places that must agree: the public
settings (`openblog.json`, Admin) and the Netlify environment. The design is in ADR 0322.

1. **Create a Turnstile widget** in the Cloudflare dashboard (Turnstile → Add widget), listing your
   public hostname. Use the *Managed* mode. You get a public **site key** and a private **secret**.
2. **Public settings.** In Admin → Analytics, open *Comment captcha (advanced)*, choose Cloudflare
   Turnstile and enter the site key, or add to `engagement` in `openblog.json`:

   ```json
   "captcha": { "provider": "turnstile", "siteKey": "YOUR_PUBLIC_SITE_KEY", "scope": "session" }
   ```

   `scope` is `session` (default) or `every-comment`. Only these three public values are stored.
3. **Netlify environment variables** (set them, then redeploy):

   | Variable | Value |
   | --- | --- |
   | `OPENBLOG_CAPTCHA_PROVIDER` | `turnstile` to enforce verification; `off` or unset means off |
   | `OPENBLOG_TURNSTILE_SECRET` | The widget's secret, server only |
   | `OPENBLOG_CAPTCHA_SESSION_SECRET` | A separate, cryptographically random value of at least 32 characters, used to sign passes; not needed with `every-comment` |
   | `OPENBLOG_CAPTCHA_SCOPE` | `session` (default) or `every-comment`; must match `engagement.captcha.scope` |
   | `OPENBLOG_CAPTCHA_SESSION_TTL_SECONDS` | Optional pass lifetime, default `1800` (30 minutes), kept between 60 and 86400 |

   Never enter a secret in Admin, `openblog.json`, generated pages or source control. Then rebuild
   so pages carry the public attributes.
4. **Check it.** `node scripts/deployment-smoke.mjs <site-origin> <admin-origin> <open-post-path> --captcha`
   confirms a direct, unverified comment is refused with `captcha_required` (it stores nothing when
   protection works; use a disposable deployment to diagnose a misconfiguration).

How it behaves:

- `POST /comments` checks origin, policy and fields, then the captcha, then the rate limit, then
  stores. An unverified comment gets `403 captcha_required`; an expired pass gets `403 captcha_expired`.
  A valid `captchaToken` is verified with Cloudflare (5 second limit) and answered with
  `captchaPass` and `captchaPassExpiresAt`. The browser keeps the pass in `sessionStorage`, so it
  ends with the tab, and sends it with later comments. Existing comment quotas still apply to every comment.
- Every verification attempt spends a separate `captcha` bucket, before the provider is called, in the existing rate-limit function (10 per
  client and 1,000 per site per hour) and then answer `429 captcha_rate_limited`. The bucket name is
  data, so **no SQL migration** is needed.
- Enabled with a missing or invalid variable, the function refuses comments with
  `503 captcha_unconfigured`, naming the variable (never a value) instead of accepting unverified
  comments. A misspelled provider or scope fails the same way.
- A stateless HMAC-SHA256 pass carries only the site id, an expiry and a random id. It authorizes
  comment submissions for that site and nothing else. Passes cannot be revoked one by one: rotate
  `OPENBLOG_CAPTCHA_SESSION_SECRET` to invalidate them all.
- To roll back, set `OPENBLOG_CAPTCHA_PROVIDER` to `off` (or remove it) and set the public provider
  to Off; comments then behave exactly as before. Local `openblog serve` comments never use this.

What the provider receives: nothing loads when a page is viewed. When a reader first clicks or
types in the comment form, their browser requests Cloudflare's script
(`https://challenges.cloudflare.com/turnstile/v0/api.js`), so Cloudflare sees the reader's IP
address and browser details. Your function sends Cloudflare the widget secret, the one-time
challenge result and the reader's IP address for verification. The form tells readers this in one
line above the Submit button. Blocked scripts show a plain explanation and a Retry button and keep
the typed text.

Security headers: the site's `netlify.toml` publishes no Content-Security-Policy, so nothing is
added for the provider. If you add your own, allow only `https://challenges.cloudflare.com` in
`script-src` and `frame-src`, and only on sites that use captcha. No `connect-src` is needed,
because verification runs on the server.

Testing with Turnstile's [published test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)
on a disposable deployment (never production): the always-passing site key
`1x00000000000000000000AA` with secret `1x0000000000000000000000000000000AA`, the always-failing
secret `2x0000000000000000000000000000000AA`, and the token-already-spent secret
`3x0000000000000000000000000000000AA`. The verifier does not pin the response hostname so these
keys work. The repository's checks run the real function handler with a fake provider:
`tests/web/comment-captcha.test.mjs` (server), `tests/web/comment-captcha-component.test.mjs`
(browser component) and the Playwright specs `tests/browser/comment-captcha.spec.mjs` and
`comment-captcha-admin.spec.mjs`.

Troubleshooting: *"Comment verification is enabled but X is not set correctly"* means that
variable is missing, too short or misspelled; fix it and redeploy. A reader who sees *"The human
check could not load"* has the provider's script blocked; they can retry or come back later. If
every comment gets `captcha_required`, check that `OPENBLOG_CAPTCHA_SCOPE` matches the public
`scope` and that the pages were rebuilt after enabling.

## Passage feedback (optional)

The same function can accept typed passage feedback: a reader's question, suggested source,
suggested correction or other interpretation of a passage, with the passage target and the
revision of the page they saw (ADRs 0079 to 0081). It is off by default. A site that does not opt
in needs no extra table, publishes nothing new and behaves exactly as before.

To opt in:

1. Run [`supabase/feedback.sql`](../../supabase/feedback.sql) in the Supabase SQL editor, after
   `openblog.sql`. It only adds two private tables, `openblog_feedback` and its moderation audit
   trail `openblog_feedback_events`, and the moderation function `openblog_moderate_feedback`; it
   changes no existing table, column, function or row, and running it twice is harmless.
2. In Netlify, set `OPENBLOG_FEEDBACK_ENABLED` to `true` and redeploy. Any other value, or no
   value, keeps the feature off, and the feedback routes then answer `404` with a short explanation
   without touching Supabase.
3. In `openblog.json`, set `"feedback": true` inside `engagement` (hosted engagement must be
   enabled with an endpoint). That switches on the four passage feedback kinds as
   `follow-comments` (ADR 0101): each post's mode for them is its `comments:` setting (`open`,
   `locked` or `hidden`). To set a kind on its own, name it in `participation.kinds` instead; see
   [Configuration](../../docs/configuration.md#reader-participation). The build then publishes
   `openblog-participation.json`, each post's mode for each kind; the function reads it from
   `OPENBLOG_SITE_ORIGIN` and accepts a note only where its kind is `open`. (It also writes B5's
   older `openblog-feedback.json`, read only by a site built before the participation manifest.)
   Each post with an open kind also gets a "Questions and corrections" form offering those kinds
   (ADR 0082). Optionally set
   `"feedbackContact"` inside `engagement` to a `mailto:` address or an `https:` contact page, which
   the form offers when a note cannot be sent.

The routes are `POST /api/feedback` (public, same-origin only) and `GET`/`PATCH
/api/admin/feedback` (moderation, `Authorization: Bearer` with `OPENBLOG_ADMIN_API_KEY`). Every
submission is checked with the same rules as the build, stored `pending` with the time the
function received it, and limited by the existing hourly quota (5 per client, 500 per site). A
reader's name is stored apart from comments and is never public unless they agreed. No e-mail is
collected and nothing is sent to readers. When the endpoint is missing, off or failing, the page is
unchanged and readers can copy their note to the author instead.

### Moderation

Feedback is moderated with comments in **Admin → Moderation inbox**; see
[Moderation inbox](#moderation-inbox). B5's `GET`/`PATCH /api/admin/feedback` routes (ADR 0083)
still answer for other tools: a change is `{id, action, from, expectedVersion, reason?, actor?}`
with `approve`, `reject` or `remove`, applied only while the item still has the state and version
the moderator saw, with its audit event in `openblog_feedback_events`; otherwise `409` with the
item as it is now. Approved notes are copied, without anything private, to
`content/reader-feedback.json` in the site's repository, which the build publishes; the function
never serves them to readers.

### Rolling back

1. Remove `OPENBLOG_FEEDBACK_ENABLED` in Netlify (or set it to anything but `true`) and redeploy.
   Feedback routes stop at once; comments and analytics are unaffected.
2. Optionally set `"feedback": false` in `openblog.json` (and switch off any passage kind named in
   `participation.kinds`) and rebuild, which stops offering the kinds in the manifests and removes
   the forms from posts.
3. To remove the stored feedback too, export it if you want to keep it, then run
   [`supabase/feedback-rollback.sql`](../../supabase/feedback-rollback.sql). It drops only the
   moderation function, `openblog_feedback_events` and `openblog_feedback`. Without this step the
   tables simply stay unused.

## Moderation inbox

Admin moderates comments and passage feedback in one list, **Admin → Moderation inbox** (ADR
0105), through `GET` and `PATCH /api/admin/moderation` with the saved moderation token, which never
reaches the browser. Admin works out, for every item, the role the signed-in account has on that
item's post (site Admin, coordinator or contributing author of a shared reflection) and shows only
what that role may see and decide; the function decides every change again from the stored row
before writing it.

Out of the box the inbox works with the tables you already have and offers what they can store:
comments can be approved, rejected, removed (stored as rejected) and reopened; feedback can be
approved, rejected and removed. To offer every decision, including asking a reader to clarify and
reopening feedback, with a version and an audit event for each comment (ADR 0106):

1. Run [`supabase/moderation.sql`](../../supabase/moderation.sql) in the Supabase SQL editor. It
   only adds three columns to `openblog_comments` (`version`, `moderation_state`,
   `moderation_reason`), the private audit table `openblog_comment_events` and the function
   `openblog_moderate_comment`. Public comment reads are unchanged: `status` still holds only
   pending, approved or rejected, and a removed comment is stored there as rejected.
2. If you use passage feedback, run [`supabase/feedback.sql`](../../supabase/feedback.sql) again. It
   adds `item_revision`, `approved_revision`, `clarification_asked` and `clarification_consent` to
   `openblog_feedback`, `kind`, `item_revision` and `actor_role` to `openblog_feedback_events`, and
   the function `openblog_moderate_feedback_item`. Nothing already stored changes.
3. Set `OPENBLOG_MODERATION_ENABLED` to `true` in Netlify and redeploy. From then on the older
   `PATCH /api/admin/comments` answers `409`, because it would skip the comment's version, state
   and audit event.

To undo it, remove `OPENBLOG_MODERATION_ENABLED` and redeploy, then optionally export the audit
tables and run [`supabase/moderation-rollback.sql`](../../supabase/moderation-rollback.sql), which
drops exactly what the two steps above added and leaves every comment, feedback item and its
state in place. Nothing in the inbox e-mails anyone.

## Engagement protection (optional)

Reader receipts, abuse reports, deletion requests and the retention run (ADRs 0107 and 0108) need
the moderation inbox's schema above, then:

1. If you use passage feedback, run [`supabase/feedback.sql`](../../supabase/feedback.sql) again.
   It adds `receipt_hash` (the digest of a reader's receipt, never the receipt) with a unique
   index, `purged_at` and a check that a purged note is never approved to `openblog_feedback`,
   a nullable `related` column to `openblog_feedback_events` (the report an upheld-report removal
   came from), and the deletion function `openblog_erase_feedback`.
2. Run [`supabase/protection.sql`](../../supabase/protection.sql). It adds `purged_at` and the same
   check to `openblog_comments`, the same `related` column to `openblog_comment_events`, the
   private tables `openblog_abuse_reports` (no reporter identity) and
   `openblog_abuse_report_events`, the functions `openblog_moderate_report`,
   `openblog_uphold_report`, `openblog_purge_comment` and `openblog_purge_report`, and lets the
   service role delete audit events, which only the retention run does. A trigger on each audit
   table (`openblog_keep_recent_audit_events`) refuses to delete any event recorded in the last
   day.
3. Set `OPENBLOG_PROTECTION_ENABLED` to `true` (with `OPENBLOG_MODERATION_ENABLED`) and redeploy.
   Set `"receipts": true` inside `engagement` in `openblog.json` so readers can use their receipts
   on the page, and `"abuse-report": "open"` in `participation.kinds` to take reports.

The function then returns a receipt with each note (`202 {receipt}`), takes `POST /receipt`
(read, `consent`, `clarify`, `withdraw`) and `POST /reports`, both origin-checked and quota-bound,
lists reports in the inbox, upholds them with `openblog_uphold_report`, deletes a closed item's
text for the site Admin, and serves the retention dry run and run at `GET` and `POST
/admin/retention`. A repeated note or comment from the same client within the hour answers
`409 duplicate`. Nothing is e-mailed to anyone.

To undo it, remove `OPENBLOG_PROTECTION_ENABLED` and redeploy, optionally export the report tables,
and run [`supabase/protection-rollback.sql`](../../supabase/protection-rollback.sql) (before
`moderation-rollback.sql` if you undo that too). It drops exactly what the steps above added and
leaves every comment and note in its state; text already purged cannot be restored.

## Evidence and correction decisions (optional)

A suggested source or correction may carry the reader's evidence block, and the author can record
a correction decision on it in the Moderation inbox (ADRs 0116 and 0117). Both need the moderation
inbox's schema above, then:

1. Run [`supabase/feedback.sql`](../../supabase/feedback.sql) again. It adds two nullable columns
   to `openblog_feedback`: `evidence` (the reader's block, only on a version 2 row, at most 4 KiB)
   and `decisions` (the author's append-only decision log), a check that evidence is only stored
   with format version 2, a trigger (`openblog_feedback_purge_evidence`) that deletes the evidence
   block whenever a note's text is purged, and the function `openblog_record_feedback_decision`,
   which appends one decision with a `decide` audit event in `openblog_feedback_events` only while
   the item is a pending or approved suggestion, not the text a clarification asked about, at the
   text revision and with the number of decisions the author saw. Nothing already stored changes.
2. Set `OPENBLOG_CORRECTIONS_ENABLED` to `true` (with `OPENBLOG_FEEDBACK_ENABLED` and
   `OPENBLOG_MODERATION_ENABLED`) and redeploy. Set `"evidence": true` inside `engagement` in
   `openblog.json` so the form offers the evidence fields.

The function then takes version 2 submissions at `POST /feedback`, checked by the shared validator
before the quota and stored pending, lists the evidence block and the decision log in the inbox,
and records decisions at `POST /admin/decisions` (token only). Without the variable a version 2
submission is refused with `unsupportedVersion`, as B5 refuses it, and the reader can copy the note
instead. A decision never changes an item's state, version or approval, never edits a post, a
citation or the Source Library, and nothing is e-mailed to anyone.

To undo it, remove `OPENBLOG_CORRECTIONS_ENABLED` and redeploy, optionally export the two columns,
and run [`supabase/corrections-rollback.sql`](../../supabase/corrections-rollback.sql). It drops
exactly what step 1 added; a note sent with evidence keeps its text and state and is read as the
version 1 note it then is, and the `decide` audit events stay.
## Suggestions for future work (optional)

A reader's question or suggested source for the author's future work (ADRs 0152 to 0161) is one
`openblog_feedback` row of kind `future-suggestion`: the page in `work`, no passage `revision` or
`target`, the reader's words in `body` and `{type, url?, hints?, about?, contact?}` in `details`.
Every hosted suggestion has a receipt, so the reader can always take it back; suggestions therefore
need passage feedback's table, the inbox's schema and the engagement protection above, then:

1. Run [`supabase/feedback.sql`](../../supabase/feedback.sql) again. Its one change to something
   that exists is a check it loosens: `openblog_feedback_passage_complete` becomes "no revision and
   no target, or a page, a revision and a target", so a row may have a page and no passage. It drops
   the constraint if it exists and adds the new one, so it is safe to run twice, and every row
   already stored still satisfies it. Nothing is rewritten.
2. Set `OPENBLOG_SUGGESTIONS_ENABLED` to `true` (with `OPENBLOG_FEEDBACK_ENABLED`,
   `OPENBLOG_MODERATION_ENABLED` and `OPENBLOG_PROTECTION_ENABLED`) and redeploy, and set
   `"future-suggestion": "open"` in `participation.kinds` and `"receipts": true` in `engagement`.

`POST /feedback?work=/posts/tides/` then takes a suggestion (`kind: "future-suggestion"`) by its own
contract (`web/components/future-suggestion.js`, held to the build by
`tests/fixtures/future-suggestion-submissions.json`, and its link rule by
`tests/fixtures/public-urls.json`): at most 12 KiB, always pending, `work` a page the deployed
`openblog-participation.json` says is open for the kind, five an hour per client and 500 per site
(bucket `suggestions`), and the same suggestion for the same page from one client once an hour. The
function calls only the database and the site's own manifest: a link a reader gives is stored, never
opened. Through `POST /receipt` the reader reads it (their own text and contact), agrees to be asked,
answers a clarification (the text is replaced; the link, hints, page and contact stay) or withdraws
it, which deletes its text, name and contact at once; a receipt never says a suggestion is published.
A report against one is refused exactly as a report against an id that does not exist. The inbox
lists it (`kind=future-suggestion`) and decides it by the one state machine.

The retention run gains a step, `scrub-identity`: an approved suggestion is kept, but its
`details.contact` and an unpublished `reader_name` are cleared (and nothing else) once `closedDays`
have passed since approval, with a version raise and an audit event that holds nothing of the reader.
The dry run lists only suggestions that still hold one of those.

To undo it, remove `OPENBLOG_SUGGESTIONS_ENABLED` and redeploy, export the rows (`where kind =
'future-suggestion'`) and, only if you want the old check back, delete those rows and the audit
events that refer to them and run
[`supabase/future-suggestions-rollback.sql`](../../supabase/future-suggestions-rollback.sql). It
refuses, and changes nothing, while any row has a page and no passage; it never deletes a reader's
row itself. Leaving the loosened check in place is harmless to every other kind.

## Third Perspectives (optional)

A Third Perspective (ADRs 0109 to 0114) is a reader's own reflection on a work, stored as one
`openblog_feedback` row of kind `third-perspective`. Every hosted copy gets a receipt, so the reader
can always take it back; Third Perspectives therefore need passage feedback's table and the
engagement protection above, then:

1. Run [`supabase/feedback.sql`](../../supabase/feedback.sql) again. It adds one nullable column,
   `approved_consent` (the reader's consent record an approval covers), and the function
   `openblog_moderate_third_perspective`, which takes every inbox decision on a Third Perspective
   and refuses an approval whose consent record is no longer the one in effect or no longer agrees
   to publish. Nothing already stored changes.
2. Set `OPENBLOG_THIRD_PERSPECTIVES_ENABLED` to `true` (with `OPENBLOG_FEEDBACK_ENABLED`,
   `OPENBLOG_MODERATION_ENABLED` and `OPENBLOG_PROTECTION_ENABLED`) and redeploy, and set
   `"third-perspective": "open"` in `participation.kinds` and `"receipts": true` in `engagement`.

`POST /feedback` then takes a Third Perspective (`kind: "third-perspective"`) by its own contract
(`web/components/third-perspective.js`): always pending, with its prompt category, the receipt's
digest and the reader's numbered consent records in `details`, and the same quotas and replay bound
as passage feedback. Through `POST /receipt` the reader reads it (the category, never their consent
records), agrees or declines to be asked (a new consent record, and a new version, so an approval
made on the earlier consent is refused), agrees or declines to let an editor feature the reflection
(`action: "feature"`, `consent`, and for an agreement the `revisionSeen` they are looking at: a new
consent record and version, allowed while the reflection is pending, in clarification or approved, and
refused as a stale view when the revision is not the one in effect; no schema change, since consents
live in `details`), answers a clarification (the text is replaced; the
details stay) or withdraws it, which deletes its text and name at once. The inbox lists it with
`approvedConsent`, and an approval names the text revision and consent record the moderator saw
(`seenRevision`, `seenConsent`). B5's own `/admin/feedback` view lists only passage feedback and
never decides a Third Perspective, even with the variable unset. A receipt says a reflection is
published only while its approval and the reader's consent in effect both allow it; Admin writes
approved reflections to `content/third-perspectives.json`, which the site builds from, so pages
never read these rows. Nothing is e-mailed to anyone.

Before undoing it, take the published reflections off the site: empty `content/third-perspectives.json`
(or set `"third-perspective": "hidden"` in `participation.kinds`) and rebuild. Without the consent
column the function cannot tell whether an approved reflection may still be shown, so a receipt says
it cannot tell, Admin says the state is unknown instead of "must come off", and abuse reports fall
back to plain approval at the current text. Withdrawals made afterwards are not checked against the
consent, so nothing a reader withdrew would be flagged for removal.

To undo it, remove `OPENBLOG_THIRD_PERSPECTIVES_ENABLED` and redeploy, optionally export the rows
(`where kind = 'third-perspective'`), and run
[`supabase/third-perspective-rollback.sql`](../../supabase/third-perspective-rollback.sql) before
any other rollback. It drops exactly the column and function above and leaves every row in its
state.

### Author responses (optional, no SQL)

An author's answer to a Third Perspective about their own section (ADRs 0131 to 0135) is one more
`openblog_feedback` row, of kind `author-response`: no new table, column or function, so there is
nothing to run in Supabase and no rollback file. Set `OPENBLOG_AUTHOR_RESPONSES_ENABLED` to `true`
(on top of the Third Perspectives settings above) and redeploy, and set
`"author-response": "open"` in `participation.kinds` for the works that take answers.

Only Admin's token reaches `admin/author-response`: `POST` stores one answer (always pending), `PATCH`
lets the account that wrote it withdraw it. Admin checks, against the private shared-publication
record this function never holds, that the signed-in account is the contributor bound to the
section; the function reads the request strictly (`netlify/lib/author-response.mjs`, held to
`tests/fixtures/author-responses.json` by the build), reads the parent row itself and checks it
again (a Third Perspective of that work, shown now, about that contributor's own section, at the
version Admin saw), allows one answer pending or shown per reflection, 20 an hour per account, and
the same answer once an hour. The row keeps the parent's id, the contributor handle, the published
name and the section's standing, and privately the participant and Admin account that wrote it; the
inbox lists it (`kind=author-response`), a coordinator approves it only under a shown parent and never
as the account that wrote it (and never while another answer to that reflection is shown), and B5's
`/admin/feedback` never decides one. The function publishes and e-mails nothing: Admin writes an
approved answer into `content/third-perspectives.json` (ADR 0137), which is how the post shows it.
Abuse reports about an answer whose reflection is not shown answer `unavailable`, as for an answer
that does not exist.

To undo it, remove `OPENBLOG_AUTHOR_RESPONSES_ENABLED` and redeploy. Existing answers stay private
in the inbox, where they can still be rejected or removed but not approved.
