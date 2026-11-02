# ADR 0320: The Facebook adapter posts a message and link to the Page feed with the Page token in the header and reads Graph error codes

- Status: Accepted
- Date: 2026-10-29
- Parent epic: [#353](https://github.com/journey-to-code-org/open.blog/issues/353)
- Story: #358 (task #374)

## Context

Facebook posts to a Page with that Page's own access token, found during discovery (ADR 0300) and stored sealed per
account (ADR 0295). Graph reports most failures as a 400 with an error code in the body, not as the HTTP status
that would explain them, and its answer to a successful post is a JSON object with an id.

## Decision

- **Same contract as LinkedIn (ADR 0319).** `facebookAdapter(settings, { fetchImpl, now })` implements the worker's
  interface: `publish({ post, account, accessToken, signal })` with `accessToken` being the Page token the credential
  store opened for that account and `account.externalId` the numeric Page id. It resolves to `{ providerPostId }` or
  throws a `DeliveryError`.
- **Request.** `POST {apiBase}/{pageId}/feed` (the Graph version is the configured setting) with a form body of
  `message` (the caption) and `link` (the canonical post), and the worker's abort signal. The token is sent as
  `Authorization: Bearer`, never as an `access_token` parameter, so it is in no URL or body that a proxy or access
  log could keep. Permissions are the ones discovery already verified (`pages_manage_posts`, and a role with
  `CREATE_CONTENT`); the adapter does not re-request them. No idempotency key exists for this call (ADR 0319).
- **Success.** Only HTTP 200 with an `id` shaped `<pageId>_<postId>` for the same Page. Anything else that is 2xx
  is `uncertain`.
- **Errors are read by Graph code, then by status.** `190` and `102` are `auth`; `10` and `200`-`299` are
  `rejected`; `4`, `17`, `32`, `341`, `613` and Meta's business-use-case limits `80000`-`80014` (`80001` is the
  Pages one, "too many calls to this Page account") are `rate-limited` (with `Retry-After` when Graph sent one,
  otherwise the worker's back-off), so a throttled Page is paused and retried rather than failed; `1` and `2` ("an unknown error occurred") are `uncertain`, because Graph can say that after
  creating the post. Other codes fall back to the status rules of ADR 0319. The message, type, subcode and trace id
  are never copied.
- **Reconcile is a read-only look at the Page's own posts.** `reconcile({ post, account, accessToken, attemptedAt,
  finishedAt, signal })` sends `GET {apiBase}/{pageId}/published_posts?fields=id,message,created_time,attachments{url,unshimmed_url}`
  with `since` two minutes before the attempt started, `until` two minutes after it finished (15 minutes after it
  started when no end was recorded) and `limit=25`, token in the header; a returned post whose `created_time` lies
  outside that window is ignored. A post of this Page whose `message` equals the caption **and** whose attachment
  links the canonical URL is a match. Exactly one match, and no post that matches by only one of the two, is
  `{ state: "published", providerPostId }`. Two matches, or a near match (a hand-made share of the same link, a
  sibling announcement of the same post, a caption edited on Facebook), is `{ state: "unknown" }`: neither a caption
  nor a link is unique to one announcement, so the look ends with a person rather than a guess. When the window holds
  no post of the Page at all it is `{ state: "absent", conclusive }`, conclusive only if Graph returned the whole
  window (no `paging.next`); any other post of the Page in the window is `{ state: "unknown" }`, because an edited
  caption on a rewritten link matches neither way and a wrong absence lets a person post the announcement twice; the worker still waits for its settle time before believing an absence (ADR 0318). If the id found
  is already recorded on another announcement of the account (the unique index refuses it), the worker gives the
  announcement `needs-review` at once instead of looking again. Anything else (no start time, a missing `pages_read_engagement` grant, an error, an unreadable answer)
  is `{ state: "unknown" }`; it never throws and never posts.

## Considered options

- **`access_token` as a form field.** Rejected: it is what the Graph docs show, but the header is accepted and
  keeps the token out of anything that records bodies.
- **Treat every 400 as final.** Rejected: Graph returns throttles and expired tokens as 400 too, and they need
  opposite handling.
- **Reconcile through `/{pageId}/feed`.** Rejected: the feed also lists other people's posts on the Page;
  `published_posts` lists only the Page's own.
- **Match by caption or by link.** Rejected: the schema allows several announcements of one post to one Page, and
  an author can share the link by hand, so either alone can name someone else's post and mark an unposted
  announcement published. A caption edited on Facebook now ends with a person, which is the safe direction.
- **An open-ended window (`since` only).** Rejected: a later announcement with the same caption and link would be
  found by every look over the 3.5 days an outcome stays unknown.

## Consequences

- Graph error codes are a small table in `social-publish.mjs`; a code Meta adds falls to the status rules, which
  fail closed (final refusal for 4xx, `uncertain` for 5xx).
- A Page token does not expire, so `auth` normally means the author removed the app or lost the Page role. The worker
  then moves the account to `needs-reauth` (ADR 0319), so the rest of its queue fails fast until it is reconnected.
- Reconcile needs `pages_read_engagement`, which is requested by default but optional; without it every unknown
  Facebook outcome is settled by a person, exactly as for LinkedIn.
