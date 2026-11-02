# ADR 0023 — Add-ons: letting other developers extend Kin safely

Status: **Proposed (not planned yet)** (#688). Parked by the owner on
2026-10-21. This record settles the design so the seams stay right; nothing
in it is scheduled or built. Weather is the motivating first example.

## Context

The owner wants a marketplace-like way for other developers to build add-ons
that a household can browse and turn on. Weather on the kitchen display is
the first example ([ADR 0022](0022-family-hub.md) left it out on purpose).

Facts that shape the design:

- **Household data is end-to-end encrypted** and decrypted only in Kin's own
  page. Any code that runs in that page can read the whole history, the
  member's private log, the keys in memory and IndexedDB. An add-on must
  therefore never run in Kin's origin.
- **Kin's page is locked to its own origin.** `web/index.html` sets
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src
  'self'; …` in a meta tag, and `setHeaders` in `server/server.mjs` sends
  `frame-ancestors 'none'`, `X-Frame-Options: DENY` and
  `Permissions-Policy: camera=(self), microphone=(self), geolocation=()`.
  Today Kin cannot frame or fetch anything from another origin.
  THREAT-MODEL C4 already plans to move the whole policy into a header.
- **The service worker only handles Kin's origin.** Its fetch handler in
  `web/service-worker.js` returns early for any request whose origin is not
  `self.location.origin`, and for `/api/`.
- **ADR 0022 left the seams.** Kitchen display panels are data:
  `web/display/panels.js` lists records of `{ id, component, region,
  featureId, size, label }`, `validPanel` is the check a record must pass,
  and `visiblePanels` drops records whose feature is off. Household features
  are a bit set (`web/features.js` `FEATURES`, mirrored by
  `HOUSEHOLD_FEATURE_BITS` in `server/pairing-service/shared.mjs`, bits 0–17
  used), changed by an admin with fresh confirmation through
  `POST /api/household/features/options` and `/finish`
  ([ADR 0021](0021-kin-for-everyone.md) §2).
- **Today has no such seam yet.** `composeToday` in `web/today-view.js`
  builds Today from items, routines, pins and handoffs; there is no list of
  cards defined as data.
- **The encrypted household settings are not a safe place for new data.**
  `validateHouseholdSettings` in `web/appearance/household.js` keeps only
  `name`, `appearance` and `brand`, so an older admin device that saves
  household settings drops any member it does not know
  (V1.0-COMPATIBILITY says the same of `brand`).
- **PRODUCT-BOUNDARIES and PRIVACY** forbid advertising, sale of data,
  household-content analytics, tracking and AI interpretation of household
  data. Add-ons must not become a way around them.
- **Kin takes no dependencies.** Signing, manifest parsing and the message
  API must use Web Crypto, Node's built-in `crypto` and hand-written
  validators.

## Decision

### 1. Isolation: a sandboxed frame on a separate origin, drawing nothing

- **Where add-on code runs.** Each add-on runs in a hidden
  `<iframe sandbox="allow-scripts">` loaded from the **add-on origin**, a
  host the operator configures (`KIN_ADDONS_ORIGIN`, for example
  `https://addons.kin-example.net`). It should be a different registrable
  domain from Kin's, so the browser's site isolation puts it in another
  process. If the setting is absent, add-ons are off; they are never served
  from Kin's own origin.
- **Why that gives no access.** Without `allow-same-origin` the frame has an
  opaque origin: it has no cookies, no `localStorage`, no IndexedDB, no
  service worker and no access to its parent's DOM or JavaScript objects.
  Without `allow-top-navigation`, `allow-popups`, `allow-forms` and
  `allow-modals` it cannot move Kin's page, open windows, submit forms or show
  dialogs. The frame also gets `allow=""` (no camera, microphone, location
  or other permissions), `referrerpolicy="no-referrer"` and
  `loading="eager"`, and is not focusable (`tabindex="-1"`,
  `aria-hidden="true"`). Each frame is its own opaque origin, so two add-ons
  cannot share anything either.
- **Why a frame, not a bare worker.** A browser only starts a dedicated
  worker from the page's own origin, and a shared or service worker on
  Kin's origin would run with Kin's storage. A worker started *inside* the
  sandboxed frame is allowed and is the recommended way for an add-on to do
  heavy work.
- **Add-ons draw nothing themselves.** The frame is never shown. An add-on
  sends Kin a small card description (§2), and Kin draws it with its own
  `kin-addon-card` element using `textContent`. This keeps add-ons out of
  Kin's look, easy mode, Simple view, night dimming and accessibility rules,
  makes a fake password prompt or "click here" impossible, and lets Kin keep
  the last card for offline use. Visible add-on frames are not offered (see
  Alternatives).
- **When frames run.** Kin starts an add-on's frame only while a surface
  that shows it is on screen (the kitchen display, or Today when it has the
  add-on's card) and removes it when the surface goes away, the page is
  hidden, or the add-on stops answering a ping for 5 seconds. A removed frame
  loses all its memory.
- **Content-Security-Policy, Kin's side.** Kin's page gains
  `frame-src <add-on origin>` and nothing else; `connect-src` stays `'self'`.
  Because the add-on origin is operator configuration, the policy can no
  longer be a fixed meta tag: phase 1 moves the full policy into a response
  header built by `setHeaders` (which also closes THREAT-MODEL C4) and keeps
  the meta tag as a fallback without `frame-src`, so a deployment that strips
  the header simply has no add-ons. `frame-ancestors 'none'` and
  `X-Frame-Options: DENY` stay for Kin's own pages.
- **Content-Security-Policy, the add-on's side.** The add-on origin is
  served by the Kin server on its second host name, with its own handler
  that answers no `/api/` route and sets no cookie. Every add-on document
  gets a header generated from its reviewed manifest, never written by the
  developer:
  `default-src 'none'; script-src <add-on origin>/<id>/<version>/;
  connect-src <declared hosts>; img-src 'none'; style-src 'none';
  font-src 'none'; media-src 'none'; frame-src 'none'; worker-src
  <add-on origin>/<id>/<version>/; form-action 'none'; base-uri 'none'`,
  plus `frame-ancestors <Kin origin>`, `Permissions-Policy` denying
  everything and `Cross-Origin-Resource-Policy: cross-origin`. The policy
  names the add-on origin explicitly instead of `'self'`, because the
  frame's own origin is opaque.
- **The service worker.** Kin's service worker keeps ignoring requests to
  other origins (the early return in its fetch handler), so it never caches,
  rewrites or answers for add-on files. The opaque frame cannot register a
  service worker of its own. Offline, Kin shows the last card it kept (§2)
  marked with when it was made, and starts no frame.

### 2. Capabilities: a small, versioned message API

- **Transport.** When the frame loads, Kin posts one `kin-addon-hello`
  message to `frame.contentWindow` and transfers a `MessagePort`. Every later
  message travels on that port, so no other window can inject messages.
  (Kin must post the hello with target origin `"*"`, because the frame's
  origin is opaque; it reaches only that window.) Kin ignores `message`
  events on its own window that are not from a frame it started.
- **Envelope (version 1).** A plain object, at most 16 KiB when serialized:
  `{ "kin": "addon", "v": 1, "id": <integer 1–2^31>, "type": <string>,
  "body": <object> }`. A reply carries `"re": <id>` and either `body` or
  `"error": <code>`. Kin validates every message with a hand-written
  validator per `type`: unknown types, unknown fields, wrong types or
  oversized strings are rejected with `bad_message` and counted. Ten
  rejections, or more than 20 messages a second, end the frame.
  A future version adds new types or a `v: 2`; Kin answers `v` it does not
  speak with `unsupported_version`.
- **The hello** gives only: the API version, the add-on's own ID and
  version, the person's language tag, whether reduced motion is on, the
  light or dark scheme, and the capabilities this household granted. It
  never includes a household, member or device ID, a name, or the Kin
  server's address.
- **The first capabilities.** Each is a permission an admin grants (§3).
  Exactly what each exposes:

| Capability | What the add-on may do or read | What it never gets |
| --- | --- | --- |
| `display.panel` | Send a card for the kitchen display. One panel per add-on, in the region and size its manifest names (sizes `s` or `m` only). | Anything about the display or what else is on it. |
| `today.card` | Send a card for Today, shown after the household's own items. | Anything on Today. |
| `calendar.today` | Read today's household calendar occurrences (the device's local civil date): for each, all-day or start and end local times, the time-zone name, and the title. Re-sent when they change. | Place, notes, attendees, member names or colours, countdown flags, other days, cancelled occurrences, events from calendars synced for "Just me", any private-log data. |
| `household.place` | Read the household's coarse place (§4): the label an admin typed (≤ 60 characters), a two-letter country code and an IANA time-zone name. | Coordinates, street address, the device's location. |
| `addon.settings` | Read its own settings (§3), as the admin chose them. Granted with every add-on; listed so members see it. | Other add-ons' settings, any way to write settings. |

- **The card.** One message type, `card.set`, carries: a title (≤ 40
  characters), up to 4 lines (≤ 80 characters each), an optional large value
  (≤ 12 characters, such as "14°"), an optional icon from Kin's own fixed set
  (weather symbols, a calendar, a clock, a bin, a leaf and a few more), and
  an optional "valid until" time. No HTML, no links, no images, no colours.
  Kin accepts at most one `card.set` a minute per surface and keeps the last
  valid card per add-on on the device. Every card carries a small "from
  *Add-on name*" label that Kin writes, so it never looks like Kin's own
  information. `card.clear` removes it.
- **The panel record.** On the display, each approved add-on becomes one
  record that passes the existing `validPanel`: `id` `addon-<add-on ID>`,
  `component` `kin-addon-card` (always Kin's own element, never one the
  add-on names), the manifest's `region` and `size`, `featureId` `addons`,
  and the manifest's panel `label`. It is appended after `PANELS`, so
  `visiblePanels` and `panelsByRegion` place it with no new code path. At
  most two add-on panels show at once.
- **Today** gains the matching seam in phase 1: a data list of extra cards
  (`id`, `component`, `featureId`) that `composeToday`'s caller appends.
- **No write capabilities.** No capability writes household events, items,
  chat or settings, sends notifications, or reads anything not in the table.
  A capability that writes is a new decision.

### 3. Approval, settings and what members see

- **A new household feature, "Add-ons" (bit 18),** in `FEATURES` and
  `HOUSEHOLD_FEATURE_BITS`. Switching it off hides every add-on at once
  without forgetting which are approved.
- **Each approval is a service setting changed by an admin,** exactly like
  feature switches (ADR 0021 §2), because only the service knows who is an
  admin. A new table `household_addons` holds, per household and add-on:
  the add-on ID, the approved version and manifest hash, the granted
  capabilities as a bit set, the hosts that version may reach (copied from
  the manifest, for display), who approved it and when, and a revision. It
  changes only through `POST /api/household/addons/options` and `/finish`
  with purpose `set-household-addon`, the revision checked at both steps,
  and a fresh passkey (or password for an admin without one), through the
  same `issueAuthenticationFlow` → `consumeFlow` → `confirmFresh` path as
  `/api/household/features/finish`.
- **Per capability, per household.** The approval screen lists each
  requested capability in plain words ("See the titles and times of today's
  events"), with the hosts the add-on talks to and the publisher's privacy
  line. The admin may untick any capability except `addon.settings`; an
  add-on whose manifest marks a capability as required does not run without
  it, and the screen says so before the admin confirms.
- **Delivered** in `/api/sync/status` with its revision, kept on the device
  for offline use. A household without sync (one person) stores approvals on
  the device, as features do.
- **Add-on settings and the coarse place are sealed,** not in the household
  settings v1 JSON (an older admin device would drop them on save, see
  Context). A new record per household, `household_addon_settings`, holds a
  blob sealed on an admin's device under the household's content key with
  the same key-epoch and revision rules as `/api/household/settings`:
  the place (§4) and, per add-on, the values for the settings its manifest
  declares. Kin draws the settings form from the manifest (choices,
  on/off, short text ≤ 60 characters); the add-on has no settings page of
  its own. The service cannot read either.
- **What members see.** Household › Add-ons lists, for everyone: each
  add-on that is on, its publisher, what it can see (the same plain words
  as the approval screen), which hosts it talks to, who turned it on and
  when. Members get the calm one-time note ADR 0021 uses when an add-on is
  turned on or gains a capability ("Your household turned on Weather. It
  can see your household's town and sends it to api.open-meteo.com."). Every
  card carries its "from" label. Only admins see the catalogue's Turn on and
  Remove buttons.

### 4. Network access and the weather example

- **Only declared hosts.** A manifest lists at most 4 HTTPS origins (no
  wildcards, no IP addresses, no ports other than 443). The add-on host puts
  exactly those in `connect-src`, so `fetch`, `XMLHttpRequest`, `WebSocket`,
  `EventSource` and `sendBeacon` to anywhere else fail in the browser. The
  approval screen and Household › Add-ons show the list. A new version that
  adds a host needs a fresh approval (§5).
- **What `connect-src` does not stop.** A frame can still navigate itself to
  any URL, and browsers do not apply `connect-src` to WebRTC or to DNS
  look-ups. Kin removes a frame that navigates (a second `load` event), and
  review rejects code that uses `RTCPeerConnection` or navigation, but the
  honest limit is §7: an add-on can get whatever its capabilities expose to
  anyone it chooses. Host lists keep honest add-ons honest and make review
  possible; capabilities are the real boundary.
- **The household's coarse place.** An admin sets it under Household ›
  Add-ons: a town, city or postcode district typed as text (≤ 60
  characters), with the country and time zone filled in from their device's
  `Intl` settings and changeable. Kin never reads the device's location for
  it (the `Permissions-Policy` keeps `geolocation=()`), and stores no
  coordinates.
- **How weather works.** The weather add-on asks for `display.panel`,
  `today.card`, `household.place` and `addon.settings` (units), and declares
  two hosts: a geocoding host and a forecast host (Open-Meteo's
  `geocoding-api.open-meteo.com` and `api.open-meteo.com` are the
  candidates: no API key, no account). It sends the place label to the
  geocoding host, gets the town centre's coordinates, rounds them to one
  decimal place (about 11 km), asks the forecast host, and sends Kin a card
  such as "Weather · 14° · Showers after 3 pm · High 17°, low 9°". The
  providers learn the town, the household's IP address and the request
  times, and the approval screen says exactly that. It needs no calendar
  access.

### 5. Distribution and trust

- **Manifest** (`kin-addon.json`, at most 8 KiB, parsed and validated by
  hand in both the browser and the service):

  ```json
  {
    "kinAddon": 1,
    "id": "weather",
    "name": "Weather",
    "version": "1.0.0",
    "publisher": { "name": "Kin project", "url": "https://…", "key": "ed25519:<base64url>" },
    "description": "Today's forecast for your town.",
    "privacy": "Sends your household's town to Open-Meteo to look up the forecast.",
    "entry": "index.html",
    "files": { "index.html": "sha256-<base64>", "weather.js": "sha256-<base64>" },
    "capabilities": { "display.panel": "required", "today.card": "optional", "household.place": "required" },
    "hosts": ["https://geocoding-api.open-meteo.com", "https://api.open-meteo.com"],
    "panel": { "region": "now", "size": "s", "label": "Weather" },
    "settings": [{ "id": "units", "type": "choice", "label": "Units", "options": ["°C", "°F"], "default": "°C" }],
    "minKin": "2.1.0"
  }
  ```

  `id` matches `^[a-z][a-z0-9-]{1,23}$` (so `addon-<id>` fits
  `validPanel`'s 32-character `id`); `version` is `MAJOR.MINOR.PATCH`;
  unknown members are rejected in `kinAddon` 1.
- **Signing.** Two Ed25519 signatures, made and checked with Web Crypto in
  browsers and Node's built-in `crypto` on the service:
  - the **publisher** signs the manifest's canonical bytes with the key named
    in it, which identifies the developer across versions;
  - the **catalogue** countersigns the manifest hash of each version it has
    reviewed. The Kin project holds the official catalogue key; its public
    key is built into Kin. A self-hosted operator's own catalogue key is set
    in server configuration (`KIN_ADDONS_CATALOGUE_KEY`).

  A device shows an add-on, and the add-on host serves it, only when both
  signatures verify and every file's SHA-256 matches the manifest.
- **The catalogue.** A signed JSON list (ID, versions with manifest hashes,
  name, description, capabilities, hosts, and a revocation list) served by
  the Kin service at `GET /api/addons/catalogue`. The official catalogue is
  published by the Kin project; an operator's server fetches and mirrors it
  (Node's `fetch`, no dependency), and may hide any entry. Bundles are
  stored on the operator's server and served from the add-on origin at
  `/<id>/<version>/`.
- **Review.** Every version is reviewed by the Kin project before it is
  countersigned: readable source (no minified-only code), no `eval`,
  `new Function`, `RTCPeerConnection`, navigation or dynamic `import` of
  other origins, each capability justified, each host named with its
  privacy policy, and the product rules in §8. A short static check runs
  before the human review.
- **Versions and updates.** An approval pins one version and its manifest
  hash. A newer reviewed version that asks for no new capability and no new
  host is updated to automatically, and the change appears in Household ›
  Add-ons. A version that adds either waits, still running the pinned one,
  until an admin approves again; members see "Weather wants to do more —
  ask a household admin."
- **Removal and kill switch.** An admin's Remove deletes the
  `household_addons` row, and the admin's device removes the add-on's
  sealed settings. The catalogue's revocation list (by ID, or ID and
  version) is the kill switch: the service drops revoked add-ons from
  `/api/sync/status` and sends a sync hint on the live channel, devices end
  running frames and delete kept cards, and the add-on host stops serving
  the files. An operator can revoke locally the same way.
- **Self-hosted operators** choose one of: no add-ons (the default; no
  `KIN_ADDONS_ORIGIN`), the official catalogue mirrored, or their own
  catalogue key and their own reviewed add-ons. Kin's built-in key never
  trusts an operator's catalogue, and an operator's key is trusted only by
  devices served by that operator.

### 6. Product rules and how they are enforced

- **No ads:** cards have no links or images, review rejects promotional
  text, and the catalogue lists no paid placement.
- **No tracking:** add-ons receive no household, member or device ID; their
  opaque origin cannot store an identifier; settings are read-only to them.
  What remains (IP address, request timing, browser fingerprint) is named in
  PRIVACY and on the approval screen. Review rejects analytics hosts.
- **No AI on household data:** review rejects any add-on that sends what a
  capability exposes to an AI or machine-learning service, and its declared
  hosts are checked for that. Changing this rule is an owner decision and a
  new record.
- **Enforcement** is the capability table first (an add-on cannot misuse
  data it never gets), review second, and revocation third.
  PRODUCT-BOUNDARIES gains a line: "Add-ons follow every boundary here; they
  see only what an admin grants, and never household text beyond today's
  event titles."

### 7. Threat model

- **A malicious or compromised add-on can still:**
  - send everything its granted capabilities expose (today's event titles
    and times, the household's town, its own settings) to its declared
    hosts, and, through navigation, WebRTC or DNS, to any host;
  - reveal the household's IP address and when its display is on;
  - show misleading text in its card, within the card limits and under its
    "from" label;
  - use CPU and battery on the display until Kin's ping or a member
    removes it.
- **It cannot:**
  - read the household history, chat, fridge, photos, private logs, keys,
    IndexedDB, cookies, session storage or Kin's DOM;
  - write events, items, messages or settings, or send notifications;
  - draw outside its card, show a password prompt, navigate Kin or open a
    window;
  - see data for a capability the admin did not grant, or another add-on's
    data;
  - keep anything between runs except through the settings an admin chose.
- **The operator** already serves Kin's own code, so a malicious operator
  could serve a changed add-on; that is no new trust. THREAT-MODEL gains an
  "Add-ons" section with the lists above, the self-navigation and WebRTC
  residual risk, and the service's plaintext knowledge of which add-ons and
  capabilities a household approved. PRIVACY gains: which add-ons are on is
  known to the operator; what each add-on sends where is listed in Kin; the
  place and add-on settings are sealed.

### 8. Compatibility

Everything is additive under [V1.0-COMPATIBILITY](../V1.0-COMPATIBILITY.md):

- no new event kind and no change to the household history, sync envelope,
  export or account vault formats;
- feature bit 18 (`parseFeatureSet` on older devices already masks bits it
  does not know);
- a server schema bump with forward migrations adding `household_addons` and
  `household_addon_settings`; new routes; new server settings
  `KIN_ADDONS_ORIGIN` and `KIN_ADDONS_CATALOGUE_KEY`;
- the CSP moving into a header, with the meta tag kept.

Older devices ignore approvals and show no add-ons. Each piece gets its
V1.0-COMPATIBILITY row when it is built.

### 9. Rollout

- **Phase 0 — the seams (done).** Panels as data with `validPanel`
  (`web/display/panels.js`), household features as a bit set
  (`web/features.js`), admin service settings with fresh confirmation, and
  the Kin page's same-origin CSP. Nothing loads add-ons.
- **Phase 1 — a first-party weather add-on behind the API.** The add-on
  origin and its handler, the CSP header, the message API with
  `display.panel`, `today.card`, `household.place` and `addon.settings`,
  approval and settings, the Today card seam, and Household › Add-ons. The
  only catalogue entry is Weather, published and signed by the Kin project.
  `calendar.today` waits until an add-on needs it.
- **Phase 2 — third-party catalogue.** Publisher keys, the review checklist
  and process, the catalogue browser in Household › Add-ons, revocation,
  operator mirroring and self-hosted catalogues, and `calendar.today`.

## Consequences

- Kin gets a second origin to serve, a header-delivered CSP and a message
  API it must keep stable; the add-on API version is a new frozen format
  once phase 2 opens.
- New server tables, routes and configuration; a catalogue mirror job.
- PRODUCT-BOUNDARIES, PRIVACY, THREAT-MODEL, UX, IMPLEMENTATION and
  V1.0-COMPATIBILITY are updated by the stories that build each phase.
- Reviewing add-ons is ongoing work for the project; phase 2 should not
  open until someone owns it.
- Add-ons can only show small text cards. Richer add-ons (a map, a chart)
  need a later decision.

## Alternatives considered

- **Running add-ons in Kin's origin** (as modules or custom elements). Easy
  and flexible, but an add-on would have the household's decrypted data,
  keys and storage. Rejected; no review could make that safe.
- **WASM plugins inside the Rust engine.** Rust could expose a narrow
  import table, but a plugin would still live in Kin's page and memory next
  to the keys, the engine has no network or timers, and Kin would need a WASM
  interpreter or a second instance to isolate it. Rejected.
- **Server-side add-ons** run by the operator. The service cannot read
  household data (end-to-end encryption), so they could only see what a
  device chose to send in plaintext, which makes the service a new reader
  of household data. Rejected; this record keeps plaintext on devices.
  Proxying add-on traffic through the service was also rejected: it adds
  load and a log of requests without stopping self-navigation.
- **Visible add-on frames** drawing their own UI. More freedom, but they
  break Kin's accessibility, easy mode and night dimming, can imitate Kin's
  prompts, and show nothing offline. Deferred; text cards first.
- **No add-ons; build weather into Kin.** Simplest and safest. It answers
  weather but not the owner's wish for other developers to extend Kin, and
  weather built in would still need a provider and a place. Kept as the
  fallback if phase 2 never has an owner for review.

## Open questions for the owner

1. **Add-on domain.** Is a separate registrable domain for the official
   add-on origin acceptable (cost and upkeep), or should it be a subdomain
   of Kin's?
2. **Weather provider.** Open-Meteo (no key; free for non-commercial use)
   or another, such as MET Norway? Does Kin's use count as non-commercial?
3. **Place.** Is a typed town or postcode district coarse enough and easy
   enough, or should "use this device's location once, rounded to about
   11 km" be offered (this needs `geolocation=(self)`)?
4. **Event titles.** Is `calendar.today` with titles acceptable at all, or
   should it expose only times and counts?
5. **Who reviews** third-party add-ons in phase 2, and may anyone other
   than the Kin project publish to the official catalogue?
6. **Money.** May add-ons be paid, or is the catalogue free only? Paid
   add-ons need accounts and payments that Kin does not have.
7. **Members' say.** Should a member be able to hide an add-on's card for
   themselves, or is the admin's choice for everyone enough?
