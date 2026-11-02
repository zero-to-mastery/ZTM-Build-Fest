# Jobs

A job is a post that records one piece of finished trade work: a floor, a driveway, a brake repair.
It is an ordinary post with `profile: job`, so feeds, tags, series, search and export treat it like any
other post ([ADR 0285](adr/0285-jobs-are-posts-with-a-content-profile-and-open-blog-is-not-a-field-service-tool.md)).
A site that never uses the profile builds exactly as it did before.

open.blog is not a field-service tool. There is no invoicing, estimating, dispatch, job scheduling or
payment data. A job may show a cost band as a public price signal; it is never a quote.

## Front matter

Use the usual post keys (`title`, `date`, `tags`, `description`, and so on) plus one `job` mapping:

```yaml
---
title: New oak floor in Maple Falls
date: 2026-10-21
tags: [flooring]
profile: job
job:
  trade: flooring
  service: hardwood-install
  place:
    town: Maple Falls
    region: WA
  started: 2026-10-14
  finished: 2026-10-16
  durationHours: 22.5
  costBand: 2k-10k
  materials:
    - Red oak 3/4 in
    - Matte finish
  media:
    before:
      - /images/floor-before.jpg
    after:
      - /images/floor-after.jpg
  review: rev_01
---
```

| Field | Required | Rule |
| --- | --- | --- |
| `trade` | yes | One of the trades below, or a trade the site adds. |
| `service` | yes | A short id: lowercase letters, digits and hyphens. When the site has [services](services.md), one of their ids. |
| `place.town`, `place.region` | yes | A plain name. Digits and commas are refused: towns only, never an address or postal code. |
| `started`, `finished` | yes | `YYYY-MM-DD`. `finished` is the same day as `started` or later. |
| `durationHours` | no | A number of hours greater than 0. |
| `materials` | no | Up to 50 short items. |
| `costBand` | no | `under-500`, `500-2k`, `2k-10k`, `10k-50k`, `over-50k` or `ask`. Never free text. |
| `media.before`, `media.after` | no | Up to 50 image references each: a site path or http(s) URL ending in `png`, `jpg`, `jpeg`, `gif`, `webp`, `avif` or `svg`. |
| `review` | no | The id of a saved review (letters, digits, `-`, `_`). |

Keys you add that this version does not know are kept untouched, so a file written by a newer version
survives an older one. The `job` mapping is the only place front matter may nest.

## Writing a job

In Admin, open a new post, then **Settings**, and set **Content profile** to **Job**. An **About this job** form
asks for the trade, service, town, region, start and finish dates, a price range and before and after photos,
and writes the `job` mapping above for you. An empty body gets four headings, `Problem`, `What we found`,
`What we did` and `Result`, as ordinary Markdown: change, move or delete them freely, in Visual or Markdown mode.
Choosing another profile hides the form and leaves your Markdown alone. **Check this job** shows what the build
would still ask for. The service box suggests the services your other jobs already use.

From the command line, `openblog new "New oak floor" --profile job` writes the same front matter and the same
four headings. Add `--trade`, `--service`, `--town` and `--region` to fill them in; each is checked the way the
build checks it, and an unknown trade is refused with the bundled trades and your own `extraTrades` listed. A job
made this way is always a draft (the dates start as today), so a half-written one never stops a build; it is
reported as `job not ready to publish` until you finish it and remove `draft`.

## Capturing a job from a phone

On site, open **Capture** in Admin's navigation (`#/capture`). It is one column built for a 400 px screen: a
large **Add photos** button (your phone offers the camera or the photo library), the trade, a service, a town
(your last few towns are one tap away) and a **Notes** box. Trade, service and towns are remembered on that
device only. **Save draft** makes an unpublished job draft you can find in Write: the Job form's keys, the four
headings, your notes under the first and the photos after them. Nothing is published, and no AI provider is
contacted. A capture holds at most twelve photos (each within your upload limit) and 8,000 characters of notes.

If the connection drops, nothing is lost: **Save draft** keeps the capture on the phone (in the browser's
IndexedDB) and sends it when you are back online, or when you open Capture again, or when you tap **Send now**.
Waiting captures are listed under **Waiting to send**, and each can be discarded. Sending twice never makes a
second draft, because every capture carries its own id. The phone keeps at most five waiting captures, 60 MB
each and 120 MB in all, and says so when one does not fit; it never deletes a capture on its own. A browser
without IndexedDB sends straight away instead.

Where the browser allows it, **Record a voice note** talks instead of types: it starts only when you tap it
(the browser then asks for the microphone), shows the time, and stops with **Stop recording**, at three minutes
or at 8 MB, whichever comes first. **Discard** throws a recording away. A finished note plays back in the view
and is sent with the capture, then kept privately on your own server (in `.openblog/captures/`, never in your
site's files or the post). Nothing is transcribed and nothing is sent to an AI unless you choose it: under a
finished note, **Transcribe with AI** (shown only when your site has an Assistant provider that takes audio, or a
local engine) first shows where the recording would go and what is sent (the recording only), and sends it only
when you tap **Send the recording**. The words come back into **Notes** under what you typed, as plain text for you
to correct, and **Undo the transcript** takes them out again. With no provider, Capture says so and you type your
notes. A browser that cannot record simply shows no Record control. Setting up a provider or a local engine is in
[the admin guide](admin.md#transcribing-a-voice-note).

**Draft with AI** (under the voice note) turns your notes, typed or from a transcript, into a title, a one-sentence
description and the four sections in your own words. It appears only when your site has an Assistant provider
(set one up in Assistant settings; see [the admin guide](admin.md)) and you have notes. Tapping it first shows where the
notes would go and what goes with them (the trade, service and town, and your voice guide if you leave **Write it in my
voice** ticked); nothing is sent until you tap **Send to the Assistant**. The draft arrives as ordinary fields you can
change, marked "not saved yet", and **Undo the draft** takes it all back in one step. It says only what your notes
say and leaves a section empty when they do not, and it never fills the job's trade, dates, place or any other Job
field. Nothing is saved or published until you tap **Save draft**, which then uses the draft's title, description and
sections in place of the notes. With no provider, your typed notes become the post exactly as before.
See [ADR 0296](adr/0296-a-capture-is-a-job-draft-started-from-a-phone-built-from-the-job-forms-own-keys.md),
[ADR 0297](adr/0297-a-capture-waits-in-a-bounded-versioned-queue-on-the-phone-and-is-sent-with-its-id-as-an-idempotency-key.md),
[ADR 0298](adr/0298-a-voice-note-is-recorded-only-after-a-tap-is-bounded-in-time-and-size-and-stays-on-the-authors-server.md)
and [ADR 0302](adr/0302-transcription-is-a-separate-confirmed-call-through-the-provider-boundary-that-sends-only-the-recording-and-returns-untrusted-text.md).

## Trades
Bundled: `general-contractor`, `excavation`, `flooring`, `mobile-mechanic`, `auto-body-paint`, `roofing`,
`plumbing`, `electrical`, `landscaping`, `painting`, `hvac`, `other`. Add your own in `openblog.json`:

```json
{ "extraTrades": ["fencing"] }
```

## Archives

Jobs are browsable the way customers look for them. When a site has jobs, the build adds:

- `/jobs/`: every job, newest first, with links to each trade.
- `/jobs/<trade>/`: one trade's jobs, with links to its services.
- `/jobs/<trade>/<service>/`: one service within a trade.

They page like the home page (`postsPerPage`; later pages are `/jobs/page/2/` and so on), appear in `sitemap.xml`, and are
built in a fixed order. A trade or service with no jobs gets no page, and a site with no jobs gets no `/jobs/` at all. Feeds
are unchanged: jobs are posts, so they are in them as posts. `page` cannot be a trade or service id. See
[ADR 0286](adr/0286-jobs-archives-are-derived-from-job-posts-and-page-like-the-home-page.md).

## Checks

A published job with a problem stops the build with a sentence naming the field, for example
``job.costBand: `cheap` is not a cost band; use one of under-500, 500-2k, ...``. Every problem is listed
at once. A draft job is allowed to be unfinished: its problems are warnings, prefixed
`job not ready to publish`.
