# Video productions and release kits

Use the Video production content profile for a creator-owned companion to a YouTube video.
The Markdown remains the durable source for transcripts, production notes, links, and any
world-building or workflow material that does not fit comfortably in a platform description.

## Create a video post

Select **Video production** under **Settings → Content profile**, or write the fields directly:

```yaml
---
title: Zhalendor — Episode 1
date: 2026-10-23
profile: video
productionStatus: editing
seasonNumber: 1
episodeNumber: 1
productionCredits: Writing and direction by the Lantern Gate team; animation and edit by the episode crew
videoUrl: https://www.youtube.com/watch?v=dQw4w9WgXcQ
duration: 12 min 34 sec
thumbnail: /images/zhalendor-episode-1.jpg
aiDisclosure: AI-assisted animation with human writing, direction, and editing.
series: zhalendor
---
```

`productionStatus` follows the workflow shown in Admin's Release kit: `idea`, `scripting`,
`storyboarding`, `generating`, `editing`, `scheduled`, and `released`. Season and episode numbers
and concise production credits appear in a visible production summary. They remain ordinary,
portable front matter rather than service-specific project records.

The example site includes a [complete fictional Zhalendor episode](../content/posts/2026-10-24-zhalendor-gate-of-embers.md)
with chapters, a production checklist, shot notes, transcript, credits, and disclosure.

`videoUrl` accepts `youtube.com/watch`, `youtu.be`, and `youtube.com/shorts` addresses. The
published page rebuilds the address into a `youtube-nocookie.com` player rather than copying
arbitrary iframe input. It retains a visible fallback link to YouTube. If the same URL also
appears as a standalone link in the Markdown, open.blog renders only one player.

`duration` accepts a readable duration (`12 min 34 sec`), a clock duration (`12:34` or
`1:02:03`), or ISO 8601 (`PT12M34S`). `thumbnail` may be site-relative or absolute; the
ordinary post `cover` is used as its fallback. Builds warn when a video URL or discovery
image is missing or when the YouTube URL shape is unsupported.

The generated page emits schema.org `VideoObject` JSON-LD with its name, description,
upload date, thumbnail, embed URL, duration, contributors, series, and the authored
AI-assistance credit when those values are available. OpenBlog does not infer whether a
platform disclosure is legally or contractually required; the creator remains responsible
for the final YouTube settings and wording.

## Chapters and transcripts

Write chapters as ordinary timestamp lines anywhere outside fenced or inline code:

```markdown
## Chapters

00:00 The gate opens
00:14 A warning in the dark
01:02 Into the ruin

## Transcript

Opening narration…
```

Open **Release kit** in Admin Studio (`Alt+4`). The kit checks that the first chapter begins
at `00:00`, at least three chapters exist, timestamps are chronological, and each chapter is
at least ten seconds long. It then combines the post description, validated timestamp lines,
and optional AI-assistance disclosure into a YouTube-ready description. Review the result and
use **Copy release description**; OpenBlog never changes the YouTube video itself.

Transcript text remains part of the normal Markdown body, so it participates in site search,
feeds, accessibility review, and the site's text exports without requiring a proprietary
sidecar format.
