# Interactive web lessons, video workflow, and comment controls

Status: approved from the 2026-10-24 product conversation

## Outcomes

1. Authors can publish a `web runnable` fence with `---html`, `---css`, and `---js` sections.
   Readers edit each section, run or reset it, and inspect a live preview inside an opaque-origin
   iframe whose CSP blocks external resources, network APIs, forms, frames, and parent access.
   The interface warns that authored code can navigate its own preview and must not receive secrets.
2. Assistant guidance understands that web sandboxes are native engine syntax and may recommend
   them for browser lessons without claiming grading or hidden tests.
3. Video-production posts expose structured `productionStatus`, `seasonNumber`, `episodeNumber`,
   and `productionCredits` fields. Published posts show a compact production summary and Admin's
   release workflow shows the current stage and next-step checklist.
4. The example site includes one clearly fictional Lantern Gate Studios/Zhalendor production post.
5. Posts accept `comments: open`, `locked`, or `hidden`. Open is the backwards-compatible default;
   locked shows approved comments without the submission form; hidden emits no comment component.
   The hosted function reads a generated, deployed policy manifest and enforces it for direct API requests.
6. Admin moderation can inspect pending, approved, and rejected queues and move a comment between
   approved and rejected states. All hosted response validation and existing secret boundaries stay
   intact.

## Syntax

````markdown
```web runnable title="Try the scene card"
---html
<button id="reveal">Reveal</button>
---css
button { color: rebeccapurple; }
---js
document.querySelector("#reveal").onclick = () => { document.body.dataset.revealed = "true"; };
```
````

Every section is optional, but at least one marker and non-empty section is required. Source is
bounded in the browser, remains visible without JavaScript, and is never sent to open.blog.

## Delivery slices

1. Renderer, public component, styling, tests, documentation, and engine guidance for web sandboxes.
2. Structured video fields, production summary/workflow, fictional example, and documentation.
3. Per-post comment policy, public locked behavior, moderation queues, hosted API tests, and docs.

## Out of scope

- Dependencies, bundlers, multi-file imports, supported external resource/API access, hidden tests, grading, or
  persisted reader code.
- Real production claims about Lantern Gate Studios or Zhalendor; the example is labelled fictional.
- Reader accounts, replies, reactions, notifications, CAPTCHA, or permanent comment deletion.
