# ADR 0301: Connected accounts are managed through Admin routes that rebuild every reply from known fields

- Status: Accepted
- Date: 2026-10-29
- Parent epic: [#353](https://github.com/journey-to-code-org/open.blog/issues/353)
- Story: #355 (task #366)

## Context

The author manages connected accounts in Admin: connect, review permissions, choose a destination, reconnect an
expired account, disconnect. ADR 0293 fixes the trust model: the browser never talks to Supabase or to the hosted
social function; the Rust Admin authorizes the author and calls the function with a server-held key, naming the
Admin user. The screen must be optional, invisible when social publishing is off, keyboard operable, labelled and
comfortable on a phone, and must never put a token, key or secret where a browser can read it.

## Decision

- **Settings come from the Admin process's environment, not from `openblog.json`.** `OPENBLOG_SOCIAL_ENDPOINT`
  (an `https:` address, or `http:` only to a loopback address for local development, with no credentials, query
  or fragment) and `OPENBLOG_SOCIAL_ADMIN_KEY` (at least 32 characters, no whitespace, the same value as the
  function's `OPENBLOG_SOCIAL_ADMIN_KEY`). Neither set: the feature does not exist for Admin. Either set and
  wrong: the status route reports the names of the settings at fault and nothing is sent.
- **Every route is an ordinary Admin route.** `GET social/status`, `GET social/accounts`,
  `GET social/connections`, `POST social/connections`, `POST social/connections/<id>/select`,
  `POST social/connections/<id>/cancel`, `POST social/accounts/<id>/reconnect` and
  `POST social/accounts/<id>/disconnect` sit behind the session, the CSRF check and the same-origin check of
  `api`, are bounded to 4 KiB before the body is read (`preflight`), must say they are JSON, take only the fields
  they name, and take ids only in UUID shape. Anything else is a 404. Status is the one route that answers when
  the feature is off, with `{ "enabled": false }`, so the screen can explain how to turn it on.
- **The function is called with the key and the actor.** `Authorization: Bearer <key>` and
  `X-OpenBlog-Actor: <the signed-in Admin user>`; no redirects are followed, the call times out, and the reply is
  size-bounded.
- **Replies are rebuilt, never forwarded.** Admin reads only the fields the screen shows (strings are length
  bounded and free of control characters; ids, providers and statuses are checked by shape). A token, ciphertext,
  secret or any other field a faulty or compromised function included is dropped. A row that does not fit is
  dropped. The function's own messages are forwarded only for a refusal about the request (400, 404, 409, 413,
  429); a failure, or a key it did not accept, becomes a fixed message.
- **The provider address is checked twice.** Admin accepts an authorization URL only on `https:` for
  `www.linkedin.com` or `www.facebook.com`, with no credentials or port; the page checks again before making a
  link. The link opens in a new tab with `rel="noopener noreferrer"`. It is held in the page only: the server
  never returns it again, so a reload asks the author to start the attempt again.
- **The screen is a native custom element built with the Admin's own helpers** (`web/admin/social.js`,
  `<ob-social-accounts>`), with no framework and no storage. It shows: the providers with the permissions they
  will ask for in plain words (required and optional marked) and the exact redirect to register; attempts in
  progress; a destination choice as a fieldset of radios where an unusable destination is disabled with its
  reason; and the accounts with a status in words and a symbol, dates, the provider id, who connected it and the
  permissions granted. Reconnect is the lead action when access ran out; Disconnect asks first, in words, and can
  be declined. After each change a status line is announced and focus goes to the place the author will want next.
  Layout is one column that wraps long names and ids, with 44 px controls, and does not depend on any font's width.
- **Invisible when off.** Admin's `meta` says whether any social setting exists; the navigation entry and the
  command-palette entry appear only then (the page itself is reachable at `#/social` and explains the feature).
  The screen requests accounts and connections only after status says the feature is on.
- **Returning from the provider.** The provider's redirect lands on the hosted function's fixed page (ADR 0299),
  not in Admin. The author returns to Admin and presses "I have finished, check now", or simply returns to the
  tab, which looks again if an attempt is waiting.

## Considered options

- **Settings in `openblog.json` or the Admin private store.** Rejected: the key is a server secret of the same
  kind as the deploy keys; the environment is where this project keeps those, and a file in a repository is the
  wrong place for it.
- **Forwarding the function's JSON as it is.** Rejected: one faulty reply would put a secret in a browser.
- **A redirect from the hosted callback back into Admin.** Rejected: Admin is usually a local or private address
  the hosted function cannot know, and a redirect target taken from a request is an open redirect.

## Consequences

- A later story that shows scheduled posts reuses the same projection style and the same route prefix.
- The browser spec runs the real binary against a scripted function; no provider is ever contacted.
