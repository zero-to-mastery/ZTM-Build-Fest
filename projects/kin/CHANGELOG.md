# Changelog

Kin's release history, newest first. Versions marked *not tagged* were
development candidates that never received a release tag; their changes
ship in v1.0.0. The project's planning releases v0.0.1–v0.0.12 are
documentation only.

## Unreleased

### Added

- **Kin at home: the home server as one file you run** (#713: #714, #715,
  #716; epic #708, [ADR 0025](docs/decisions/0025-kin-at-home.md) §9–§10,
  [HOME-SERVER](docs/HOME-SERVER.md)). `KIN_MODE=home` refuses the Google
  Play settings, limits new households to one unless `KIN_MAX_HOUSEHOLDS`
  says otherwise, and keeps data in the platform's system folder.
  `scripts/build-sea.mjs` builds a reproducible, checksummed single
  executable for Linux x64 and arm64 with the server, web app and engine
  inside, writing Node's SEA blob into the node binary with Kin's own ELF
  injector (no postject); the service still runs inside Node's permission
  model. `--install-service` and `--uninstall-service` install a systemd
  unit, a launchd LaunchDaemon or, until the Rust service host (#749), a
  Windows scheduled task at boot as LOCAL SERVICE; uninstalling keeps the
  data. `deploy/home/Dockerfile` is a distroless image running as an
  unprivileged user with `/data` as a volume and a health check. The
  launcher moves into `server/launcher.mjs` and adds `--health`,
  `--supervise`, `--log-file` and `admin`. CI builds the executables and the
  image (`home-executables`, `home-container`). Builds are unsigned for
  now.
- **Kin at home on macOS and Windows** (#747, #748; story #713,
  [HOME-SERVER](docs/HOME-SERVER.md)). `scripts/build-sea.mjs` now builds
  all five targets on any machine, including `darwin-arm64`, `darwin-x64`
  and `win-x64` from Linux. `scripts/sea/macho.mjs` adds the SEA blob as
  the `NODE_SEA/__NODE_SEA_BLOB` section Node looks up, moving `__LINKEDIT`
  and its chained fixups, and `scripts/sea/codesign.mjs` replaces node's
  signature with an ad-hoc one (SHA-256 page hashes, no certificate), which
  Apple silicon requires; no Mac or `codesign` is needed.
  `scripts/sea/pe.mjs` adds the `RT_RCDATA` resource `NODE_SEA_BLOB` in a
  new resource section and removes node.exe's Authenticode certificate.
  Every executable is parsed back and checked before it is written. CI
  builds all five, and `home-executables-run` checks the signatures with
  `codesign`, runs the Mac and Windows executables and compares them with
  native builds; the Windows executable ships with the service host (#749)
  built by the `service-host` job, and CI checks that `kin.exe
  --print-service` finds it. The blob's assets are sorted and the bundled
  files keep LF endings, so Linux, macOS and Windows build byte-identical
  executables. The executable now loads its app files by their real path
  (it failed to start from a cache under macOS's symlinked temporary
  folders) and unpacks safely when several copies start at once (Windows
  refused to rename onto a folder another copy had just written). Still
  unsigned: Gatekeeper and SmartScreen warn.
- **Kin runs as a real Windows service** (#749; story #713,
  [ADR 0025](docs/decisions/0025-kin-at-home.md) §10,
  [HOME-SERVER](docs/HOME-SERVER.md)). `tools/kin-service-host` is a small
  service host in Rust with only `std` (no crates; the three advapi32
  functions it needs are declared by hand) that answers the Service Control
  Manager, starts `kin.exe`, restarts it with a backoff if it fails, and on
  stop, shutdown or preshutdown closes its stdin so the service closes its
  database, ending it after 40 seconds and reporting its exit code. On
  Windows `--install-service` now registers the service `Kin` with
  `sc.exe create` (at boot, as LOCAL SERVICE) and restart-on-failure with
  `sc.exe failure`; uninstall stops it, deletes it and keeps the data. The
  scheduled task stays as the fallback when `kin-service-host.exe` isn't
  beside `kin.exe`. The launcher gains `--stop-on-stdin-close`;
  `scripts/build-sea.mjs` ships the host beside the Windows executable; the
  CI job `service-host` tests it and runs it as a real service on Windows.
- **The connection relay** (#728: #729, #730, #731, #732; epic #708,
  [ADR 0025](docs/decisions/0025-kin-at-home.md) §1–§4). A separate,
  dependency-free Node program in `relay/` that lets phones reach a home
  server without open ports: it reads only the server name from each TLS
  ClientHello (16 KiB, 4 records, 10 seconds; fuzz-tested) and splices the
  still-encrypted bytes into the home server's KTUN v1 tunnel, never ending
  TLS for a home server's name. Home servers sign in with an Ed25519 home
  key over a signature bound to the tunnel's TLS session (exporter); a
  newer tunnel replaces an older one. Names are claimed with the key only
  (no email address), bound to it forever, retired on release and never
  reassigned except a name that got no certificate within 7 days; own
  domains are proven by a `_kin-relay` TXT record. Per-name connection and
  bandwidth limits, per-source claim and sign-in limits, an authoritative
  DNS server for the zone (no HTTPS records, so no ECH), port 80
  redirects, a SQLite registry with 30 days of hourly counters, and client
  addresses in memory only. KTUN vectors are TEST-VECTORS 186–193; the
  deploy and operator guide is `relay/README.md`. The home server's side
  of the tunnel is the next entry.
- **Kin at home: the home server's side of the tunnel** (#733: #734, #735,
  #736; epic #708, [ADR 0025](docs/decisions/0025-kin-at-home.md) §2, §5,
  §9, [HOME-SERVER](docs/HOME-SERVER.md#reaching-it-from-anywhere-the-tunnel)).
  With `KIN_MODE=home` and a name in the home settings
  (`<data>/home/settings.json` or `KIN_HOME_NAME`, `KIN_HOME_RELAY`,
  `KIN_HOME_ZONE`, `KIN_HOME_ACME_DIRECTORY`, `KIN_HOME_ACME_TERMS_AGREED`),
  the service dials the connection relay over TLS 1.3, signs in with an
  Ed25519 home key made on first run (`home/home-key.pem`, 0600) and bound
  to the TLS session's exporter, claims its free name (or adds its own
  domain), sets the CAA record before its first certificate order, and
  starts the ACME certificate manager. Each phone connection arrives as a
  KTUN stream with credit flow control both ways; the service ends TLS on
  it with its own certificate and the TLS-ALPN-01 hook, and hands the
  decrypted socket to Kin's existing HTTP server, so every route and the
  live WebSocket work unchanged. Reconnects with full-jitter backoff (1 s to
  5 min), at once after sleep or a network change; keep-alive pings; a
  newer tunnel replaces an older one; `status()` for the control panel
  (#718). Rate limits key on the phone's address from the stream's `OPEN`
  frame, per IPv4 address or IPv6 /64, ignoring `X-Forwarded-For` on tunnel
  streams only. Without a name, home mode runs on loopback as before. The
  executable and container image now include `relay/ktun.mjs`. Tested end
  to end on loopback with the real relay and the in-process ACME server.
- **Kin at home: the control panel's setup and status pages** (#718: #719,
  #720; epic #708, [ADR 0025](docs/decisions/0025-kin-at-home.md) §10–§11,
  [HOME-SERVER](docs/HOME-SERVER.md#setting-it-up-the-control-panel)).
  On first run a home server listens on loopback only, keeps the app's API
  closed, and prints a one-time setup code (10 characters without
  look-alikes, one hour, once, five tries); the launcher shows it in plain
  words and opens the browser at `http://localhost:<port>/control/` when
  started in a terminal. The setup page then: checks the name with the relay
  as it is typed (new `CONTROL` op 7 `CHECK`, which binds nothing), takes the
  agreement to Let's Encrypt's terms (linked from the CA's directory), shows
  and checks an own domain's A/AAAA, `_kin-relay` TXT, CAA (with
  `accounturi`) and HTTPS (no ECH) records, writes `home/settings.json`
  (0600) and restarts once (exit code 75, which the launcher starts again),
  follows the claim and the certificate, and sends the person to
  `https://<name>` to create the household. The status page shows the
  relay connection, name, certificate and CT check, storage, and households
  and devices as counts only, with every state and error code in plain
  words; backups (#721) and updates (#722) have their cards and seams. The
  panel is reachable on loopback (its own API with loopback, Host,
  forwarding-header and same-origin checks, after a code, with a 30-day
  session) or at `https://<name>/control/` for signed-in household admins;
  every change needs a fresh confirmation (a printed code on the computer,
  the admin's passkey or password otherwise). The first change is the
  new-household limit (1–10). A certificate running out within 14 days, or
  one this server didn't make, sends the admins the usual content-free push.
  Tested in Node, end to end through the restart against the real relay and
  the in-process CA, and in a browser (`scripts/control-panel-regression.mjs`,
  a new CI suite).
- **Kin at home: scheduled backups and restore** (#721; story #718, epic
  #708, [ADR 0025](docs/decisions/0025-kin-at-home.md) §10,
  [HOME-SERVER](docs/HOME-SERVER.md#backups-and-restore)). A home server
  backs itself up every day at 03:00 local time (the hour is a setting), or
  soon after it starts when it missed that time, into
  `backups/kin-<time>/` in its data folder: the verified database copy
  (`VACUUM INTO`, then opened and validated), the `home/` keys, certificate
  and settings, and a manifest written last. The 14 newest are kept; a
  failure is shown and tried again an hour later. The control panel shows
  the last and next backup, how many are kept and their size, and offers
  back up now, the daily time and restore, each confirmed like any other
  change. Restore checks that the backup opens, restarts Kin, and runs the
  existing restore before the database is opened (keeping the replaced
  database, deletions and current authority); a refused restore leaves the
  data as it was and says why. Before a name is chosen, the setup page
  offers a backup copied into the folder, which also brings its `home/`:
  moving a home server to a new computer.
- **Kin at home can copy each backup to a second folder, such as a USB
  drive** (#763; story #718, epic #708,
  [ADR 0025](docs/decisions/0025-kin-at-home.md) §10,
  [HOME-SERVER](docs/HOME-SERVER.md#copies-to-another-folder)). The folder
  is chosen in the control panel on the home server's own computer only
  (the copies hold every household's data and the home key), and kept as
  `backupCopyFolder` in the home settings. The launcher, outside the
  sandbox, copies every backup the folder lacks into
  `Kin backups/<name>/` there, within a minute of each backup or of the
  drive being plugged in, reading the database back to check it and writing
  the manifest last. It keeps the 14 newest there and touches nothing else.
  It never makes the chosen folder, refuses one on the same partition as
  Kin's data or an unplugged drive's empty mount point, and reports a full
  drive instead of clearing it. On Windows its folder there is kept as
  private as Kin's data folder (not possible on FAT32 or exFAT). The status page shows the copies and
  any problem in plain words. The Linux service may now write under
  `/media`, `/mnt` and `/run/media`; an existing install needs
  `kin --install-service` again for that.
- **Moving a household to a home server: the app's screens** (#737;
  [ADR 0026](docs/decisions/0026-moving-a-household.md)). Household access
  offers household admins *Move to a home server*: who can sign in at the new
  address (by name, from the household's own history), the address and the
  move code, a fresh passkey or password, and the move's progress, with
  every failure in plain words. Once it moved, the household panel and Today
  say where it went and how to sign in there (password or backup code, then
  a new passkey); an admin can undo it for a day or close the old household,
  and is reminded to after a week. Sync stops for good on `household_moved`
  and waits on `household_moving`.
- **Moving a household to a home server: the sending side's server**
  (#738; [ADR 0026](docs/decisions/0026-moving-a-household.md)). A
  household admin, with a fresh passkey or password, gives the home server's
  address and the move code read there; the service freezes the household
  (sessions get `household_moving`), builds its package and sends it in
  pieces, only to a host name over https whose every address is public (the
  calendar fetcher's guard), then marks it moved: every session gets
  `household_moved` (410) with the new address, and `/api/status` says where
  it went. A failed or interrupted send leaves it in use. Readiness lists
  which members can sign in at the new address (a password or backup code);
  at least one admin must. Within a day an admin can undo the move; closing
  the old household is the existing deletion, both through the trusted
  device. Server schema 30 adds `household_moves`. The app's screens come
  next.
- **Moving a household to a home server: the receiving side** (#739; story
  #737, epic #708, [ADR 0026](docs/decisions/0026-moving-a-household.md),
  [HOME-SERVER](docs/HOME-SERVER.md#moving-a-household-here)). ADR 0026
  replaces ADR 0025 §12: the old server sends the household's own records
  (the same household, member and device IDs, so every event, vault and
  signature stays valid) straight to the home server. `server/move-package.mjs`
  builds a package of one household's rows (every table is classified as
  moving, staying or the server's own, and a test fails on a new one) with
  no device token, passkey or passkey wrapper, and imports it in one
  transaction after the full startup checks. On the home server, the control
  panel prints a one-time move code; `/api/move/*` takes the package in
  resumable 8 MiB pieces (at most 4 GB) with the code and a per-transfer
  token, checks it, adds the household and restarts. The sending side on the
  hosted service (#738) comes next.
- **Moving a household to a home server: devices from the old address**
  (#769; story #737, [ADR 0026](docs/decisions/0026-moving-a-household.md)
  §6, [HOME-SERVER](docs/HOME-SERVER.md#moving-a-household-here)). The
  household's old devices arrive with the move but can't sign in at the new
  address; the home server marks them, and People & devices shows them as
  *From the old address · can't sign in here*. A household admin removes
  them all with one button and one fresh passkey or password: one
  revocation and one new household key. The confirmation names anyone who
  hasn't signed in at the new address yet, and says they still can with
  their password or backup code, or with a recovery invitation. Until
  they're removed, those devices don't count as a way in for the last
  household admin or the last trusted Adult, so Kin still refuses to leave
  the household without one. Before any admin has signed in at the new
  address, other members can still remove their own devices (#778).
- **Kin at home: signed, safe updates** (#722; story #718, epic #708,
  [ADR 0025](docs/decisions/0025-kin-at-home.md) §10,
  [HOME-SERVER](docs/HOME-SERVER.md#updates)). Releases carry
  `kin-home-manifest.json` and a detached Ed25519 signature, checked against
  a release key built into Kin; `scripts/release-key.mjs` makes that key
  offline and `scripts/sign-release.mjs` signs a build. No key is built in
  yet, so updates stay off (and make no requests) until the owner adds one.
  With a key, the launcher checks GitHub Releases daily; patch and minor
  releases install at night (02:00 to 05:00) unless automatic updates are
  turned off, and major releases wait for an admin's *Install now*. The
  old launcher downloads and checks the file, unpacks it into its own cache,
  stops the service, backs up, and tries the new release as the sandboxed
  service (`/health` within 60 seconds, then 5 minutes up) before swapping
  the executable (`kin.previous` is kept); a failed trial puts the
  database back and starts the old version again, and that release isn't
  retried by itself. `--install-service` now lets Kin's account write its
  install folder (the unit gains `ReadWritePaths`). The control panel shows
  the version, what's available and how the last update went.

- **Kitchen display mode** (#669: #670, #671, #672; epic #651,
  [ADR 0022](docs/decisions/0022-family-hub.md) §4). An Adult turns a tablet
  into a kitchen display from Household › Overview. It stays unlocked and
  signed in as that adult (auto-lock doesn't apply; THREAT-MODEL says what
  that means), replaces the workspace with a touch-first shell that locks
  navigation, and shows today's events and countdown, the week strip, each
  child's chore chart in their colour (ticks credit the chore's owner),
  today's meals, the shopping list (add and tick), the fridge and recent chat
  messages read-only; never the journal, Just for me, reminders, Search,
  admin actions, Household settings or Chat composition. Panels are data
  (`web/display/panels.js`) for future add-ons (#688). Screen Wake Lock,
  dimming on a night schedule (21:00–06:30 by default), Family photos in
  `<kin-photo-frame>` (or a clock) after a quiet spell, portrait and
  landscape layouts with 64 px targets, and the last known state offline.
  Leaving needs the adult's passkey or password, checked on the device.
  Household feature "Kitchen display" (bit 17), Help, browser regression
  `scripts/kitchen-display-regression.mjs` and a wall-tablet checklist.
  On the display an Adult can also set or change a child's reward (kind 78)
  with 64 px buttons, with Undo (#699), and the fridge has a wall-tablet
  layout: tools beside the door, its notes repeated in large type, no full
  screen, hover titles or drop-downs (#700). Saving or removing a reward on
  the display, and Undo or Redo of one, first asks for the adult's passkey
  or password (or the backup key on a device from before accounts), with
  the same on-device check and dialog as leaving, now shared
  (`display/leave.js` `askAdult`); cancelled or refused, nothing is
  written. Ticking chores, shopping and the fridge stay open, and the
  phone's chart doesn't ask (#705).

- **Family photos** (#673: #674, #675; epic #651,
  [ADR 0022](docs/decisions/0022-family-hub.md) §5). A shared, encrypted
  family album under Household › Family photos: add several photos at once
  with captions, from the page, the share sheet ("Add to family photos") or
  a chat photo ("Add to the family photos"); a grid of thumbnails, a viewer,
  and removal by whoever added a photo or a household admin, with Undo. A
  Slideshow shows the album in the new reusable `<kin-photo-frame>`, which
  crossfades (not with reduced motion), shows captions and who added each
  photo, pauses while hidden and returns on a tap; the kitchen display will
  use it as its screensaver. Event kinds 75 `ALBUM_PHOTO_ADDED` and 76
  `ALBUM_PHOTO_REMOVED`, the WASM export `kin_album` (KALB v1), at most 500
  photos. Images are household attachment blobs, made screen-sized and
  encrypted on the device, kept in their own device database and counted in
  their own service quota. Household feature "Family photos" (bit 16), Help
  and easy mode. Browser regression `scripts/photo-album-regression.mjs`.
- **Calendar views in each person's colour** (#660: #661, #662, #663, #664;
  epic #651, [ADR 0022](docs/decisions/0022-family-hub.md) §1–2). This week
  grows into the **Calendar** with **Week**, **Day** and **Month** views
  (`#week`, `#week/day`, `#week/month`), still reached from Today, which
  stays marked. Events show in each attendee's colour with their names,
  in the viewer's own time (`Intl`; floating times as written), beside
  meals, planned items and routines; an all-day row, a day timeline with
  overlaps side by side, a month grid, and keyboard navigation between days,
  weeks and months. **Add event** (what, when, who; place, notes, repeats
  and a countdown under More details), change this one or all, cancel this
  one or all, Undo and Redo, and a calm message when the event changed on
  another device. **My calendar colour** (twelve colours, or Kin's choice
  by join order) under Identity & appearance. **Today** shows today's
  events and the next countdown. **Import a calendar file** (and **Add to
  the calendar** from the share sheet for `.ics` files) previews the count,
  then saves; importing again updates by source UID. Household feature
  **Calendar** (bit 14); This week (bit 5) stays the Week view's switch.
  `kin_calendar_range` now lists breakfast, lunch and snacks beside dinners
  (no format change). Components `<kin-calendar>`, `<kin-calendar-today>`,
  `<kin-event-editor>`, `<kin-member-colour>`, `<kin-calendar-import>`.
  Synced outside calendars (#668, `web/calendar/external.js`) show
  read-only with their source label in every view and on Today, and their
  settings follow the Calendar switch. Unit tests for zones (DST), ranges, layout, colours,
  repeats, import plans and undo; browser regression
  `scripts/calendar-regression.mjs`. UX §8.16, Help.

- **The chore chart** (#676: #677, #678; epic #651,
  [ADR 0022](docs/decisions/0022-family-hub.md) §6). From Today (and Simple
  view for children): a card per child in their colour with today's jobs —
  their routines (whose turn it is) and items — as big tick boxes with
  pictures, the rest of the week, points this week and reward progress ("12
  of 20 for Movie night"). Points go to the chore's owner, never to whoever
  ticked it, and start again every Monday; children see each other's
  totals. Parents set points per routine (0–10) on Routines and a reward per
  child on the chart. Adults join only when a household admin allows it
  (Household › Features, fresh confirmation) and then only if they choose
  to; they can leave at any time. No streaks, no adult-only leaderboard, no
  notifications about points. Event kinds 77 `CHORE_POINTS_SET`, 78
  `CHORE_REWARD_SET`, 79 `CHORE_CHART_JOINED`; WASM export `kin_chore_chart`
  (KCCQ → KCCD); **server schema 28** (`households.chore_adults`,
  `chore_adults_revision`) with routes `POST
  /api/household/chore-chart/options` and `/finish` and `choreChart` in the
  sync status; household feature bit 15 "Chore chart". The element
  `<kin-chore-chart>` is self-contained for the kitchen display.
  PRODUCT-BOUNDARIES now allows weekly points for the children's chart.
  EVENTS, ABI, TEST-VECTORS 085–089, SYNC, UX, V1.0-COMPATIBILITY.
- **Family calendar events in the engine** (#656: #657, #658, #659; epic
  #651, [ADR 0022](docs/decisions/0022-family-hub.md) §1). Event kinds 71
  `CALENDAR_EVENT_SAVED`, 72 `CALENDAR_EVENT_CANCELLED`, 73
  `CALENDAR_EVENT_RESTORED` and 74 `MEMBER_COLOUR_SET` (KCMD actions 71–74):
  all-day or timed events with a local time and an IANA zone, a place,
  notes, attendees, a countdown flag and a source UID; repeats (daily,
  weekly on chosen days, monthly or yearly by day or nth weekday, with an
  interval and a count or end date) expanded in local civil time in Rust;
  cancelling and restoring one occurrence or the series; a changed
  occurrence as a linked standalone event; each member's palette colour.
  `kin_calendar_range` (KCAQ → KCAL) reads up to 400 days, merging event
  occurrences with dated items, routines and meals, the next countdown and
  member colours. JavaScript: `web/wasm/kin-calendar.js`,
  `engine.calendarRange`, the four commands and the store's
  `calendarRange`, `memberColours` and `parseICalendar`. No views yet.
- **iCalendar import in the engine** (#666; ADR 0022 §3). A native RFC 5545
  subset parser (`rust/src/ical.rs`, `kin_ical_parse` → KICS) for Google,
  Apple and Outlook exports: unfolding, escapes, DATE and DATE-TIME with
  TZID (IANA, Windows names), `Z` or floating times, DURATION, RRULE mapped
  onto Kin's repeats (the first occurrence only, flagged, when it can't
  be), EXDATE, RECURRENCE-ID overrides and STATUS:CANCELLED; at most 2 MB
  and 5,000 events. `engine.parseICalendar(bytes)`.
- **Google, Apple and Outlook calendars, synced** (#665: #667, #668; epic
  #651, [ADR 0022](docs/decisions/0022-family-hub.md) §3). Under Household ›
  Identity & appearance › Outside calendars, an Adult pastes a calendar's
  private iCal link (`https://` or `webcal://`), chooses **Just me** or
  **Everyone in the household**, reads "Your Kin server will download this
  calendar about every 30 minutes and can read it while it does." and turns
  sync on. The list shows each calendar, who sees it, when it was updated
  or why it couldn't be, and what's next; its owner or a household admin
  turns it off for everyone. The service keeps only the link, owner,
  audience, last fetch's status and ETag (server schema 29,
  `calendar_subscriptions`), holds a downloaded feed in memory for at most
  30 minutes, and fetches it with Node's own `https` and `dns` behind SSRF
  protections (public unicast IPv4 and IPv6 only, re-checked on every
  redirect, at most 5 redirects, port 443, 2 MB, 15 seconds, backoff on
  errors; 10 calendars per member, 30 per household). Devices in the
  audience fetch it through an authenticated route, parse it with
  `parseICalendar`, keep it sealed in `kin-calendar-feeds:<household>`,
  expand its repeats on the device and hand read-only occurrences labelled
  "From Google" to the calendar views (`web/calendar/external.js`). They
  never enter the household history.
- **Fuller meal plans** (#679: #680, #681; epic #651,
  [ADR 0022](docs/decisions/0022-family-hub.md) §7). Meals plans breakfast,
  lunch, dinner and a snack for each day. Each day card has a row per meal,
  and **Show** folds meals away (on phones, unplanned ones start folded).
  **Same as last week** copies last week's meals into the empty slots.
  **Add this week's ingredients to Shopping** covers every meal and never
  duplicates. A star marks a favourite recipe, and **Favourites** filters the
  list. Favourites lead the planning dialog. Today lists today's other meals
  under Tonight, and This week lists every meal on its day. New household
  event kinds 80 `MEAL_SET`, 81 `MEAL_CLEARED` and 82 `RECIPE_FAVOURITE_SET`.
  Dinner keeps kinds 61–63, so planned dinners stay valid. New WASM export
  `kin_meal_plans` (KMLS v2) beside an unchanged `kin_meals` (KMLS v1), and
  KMPQ v2 (a slot's meal or a week). Older devices pause sync with "update
  Kin" when they meet the new kinds. Rust tests, test vectors 180–185 and
  browser regression `scripts/meal-plan-regression.mjs`. UX §8.11, EVENTS,
  ABI, V1.0-COMPATIBILITY.

- **Certificates from scratch for Kin at home** (#723: #724, #725, #726,
  #727; epic #708, [ADR 0025](docs/decisions/0025-kin-at-home.md) §5). A
  dependency-free ACME (RFC 8555) client in `server/acme/`: ES256 account,
  flattened-JWS requests with nonce handling and badNonce retry, orders,
  TLS-ALPN-01 (RFC 8737) answered through an `ALPNCallback`/`SNICallback`
  hook with a hand-encoded validation certificate carrying the critical
  acmeIdentifier extension, a hand-encoded DER PKCS#10 CSR, certificate
  download, renewal at two thirds of the lifetime with 1–24 hour backoff,
  hot swap with `setSecureContext`, a status object for the control panel,
  CAA records with `accounturi` and `validationmethods`, and a daily
  Certificate Transparency check. Keys are stored 0600. Tested end to end
  against an in-process ACME server with a real loopback TLS validation;
  started by home mode with the tunnel (#733, entry above).
  [HOME-CERTIFICATES](docs/HOME-CERTIFICATES.md), TEST-VECTORS.
- **Kin at home: certificates follow ACME Renewal Information** (#751;
  story #723, [ADR 0025](docs/decisions/0025-kin-at-home.md) §5, RFC 9773).
  When the CA's directory has `renewalInfo`, the home server computes the
  certificate's ARI identifier from its authorityKeyIdentifier and serial
  with its own DER reader, polls the suggested window (the CA's
  `Retry-After`, clamped to 1–24 hours), renews at a uniformly random time
  in it (at once when the window has passed), and names the old certificate
  in the new order's `replaces` (ordering again without it on
  `alreadyReplaced`). Two thirds of the lifetime stays the fallback when the
  CA has no ARI or a poll fails, and the renewal is never later than that
  point. `status()` gains a `renewalInfo` object with the window, the CA's
  `explanationURL` and the last poll's error; `renewAt` is now the planned
  time. The test CA serves renewal information and checks `replaces`.
  [HOME-CERTIFICATES](docs/HOME-CERTIFICATES.md#renewal-backoff-and-status),
  TEST-VECTORS.

### Changed

- **A design pass over the whole interface**, in the stylesheets only: no
  feature, control, route, markup or persistent format changes. One token
  layer (`web/styles/app.css`) now derives surfaces, shadows, focus rings and
  radii from the household's palette, so custom colours carry through. The
  header is lighter and translucent with pill controls; page titles, the
  detail title and the lock screen use one display serif, and Today's date
  reads as an eyebrow above the heading. The desktop rail has a wider pill
  for the current page; a tablet held upright (720–959 px) gets a compact
  rail of icons over their words; the phone's bottom bar is frosted with the
  current icon in a pill. Cards, chips, rows, dialogs, toasts and the
  Household hub (now with chevrons) share one elevation scale; every field
  gets the same base style at the lowest specificity; Quick add, the command
  palette and Help rise as bottom sheets on phones, as Report, Meals and the
  fridge dialogs already did. The lock screen is a centred card with
  full-width choices. Targets stay 48 px, focus rings 3 px, the 320 px,
  forced-colours, reduced-motion, text-spacing and easy-mode contracts are
  unchanged, and `--bg`, `--line-strong` and the other palette values are
  as before.
- **Documentation for newcomers and contributors.** The README now leads
  with what Kin is, what it does today and how to run it locally or on your
  own server, and links a [documentation map](docs/README.md). A new
  [SELF-HOSTING](docs/SELF-HOSTING.md) guide holds every service setting,
  the reverse-proxy rules, health endpoints, backups and restore, updating,
  and the optional GitHub forwarding of in-app reports, which the README
  used to carry. The release contracts and daily plans from v0.1 through the
  October 2026 push to v1.0 (`docs/V0.*.md`, `docs/releases/`, the preflight
  and traceability documents, and the root `AGENT-HANDOFF.md`,
  `REPLACEMENT-MAP.md` and `MANIFEST.json`) moved to
  [docs/planning/](docs/planning/README.md) with every link rewritten;
  they are history, not a backlog. `AGENTS.md` is rewritten as a current,
  short guide. `CONTRIBUTING.md` now covers setup, branches, what a good
  change looks like and how a PR is checked; the Code of Conduct adopts the
  Contributor Covenant 2.1 with Kin's privacy expectations; `SECURITY.md`
  and `SUPPORT.md` are reorganised; the issue forms gain a self-hosting form,
  a privacy checkbox and contact links; and the PR template's checklist
  matches the verification gate.
- **A sync stopped for want of the household key says where** (#791). The
  three places that pause sync with "This device needs an authorized
  household key" now each have their own code (`household_key_missing`,
  `household_key_missing_after_rotation`, `household_key_missing_for_binding`),
  and the diagnostic in a problem report also gives the key epoch that was
  missing. A refused key transfer's `provisioning_grant_refused` is now kept
  in reports too instead of reading `other`. The words people see are
  unchanged.

### Fixed

- **A page opened while Kin first saves its offline copy works offline**
  (#770). The service worker takes over the open pages when it finishes
  installing, but a page whose load had already started missed that and
  stayed without it until the next load, so locking and then unlocking it
  offline failed with "Kin could not start its household engine". The page
  now asks the worker to take it over (`KIN_CLAIM`, `web/service-worker.js`,
  `web/components/app/status.js`); `scripts/worker-claim-regression.mjs`
  checks it in its own CI job.
- **A wake counts as busy until its refresh starts** (#793). Coming back to
  Kin (window focus, the tab showing again, the Pulse timer) checks whether
  another tab locked before it refreshes, and until now Kin looked idle
  while it checked. The wake now shows as pending (`app.wakePending`,
  `web/components/app/wake.js`) from the focus until its refresh begins or
  it decides not to refresh, so anything waiting for Kin to settle waits for
  that refresh too.
- **Just for me no longer drops a tap made while saving** (#792). Ticking
  an item, saving a note, deleting, sharing or adding straight after
  another change did nothing while that change was still saving. Changes
  now wait their turn and run in order. Added words leave the field at
  once, so pressing Enter twice adds them once; if the add can't be saved,
  they come back; if the field is in use by then, the message names the
  words that weren't added. While a change waits, the list shows it as
  tapped, and a second tap that would change nothing more (Delete, Undo or
  Save twice) is ignored instead of showing "That changed meanwhile". Focus
  moves after a change only when nothing was tapped after it.
- **Kin at home's clean-ups retry on Windows whatever the Node version**
  (#785). On Windows a file can stay held for a moment after the program
  using it stops (a stopped service's `kin.sqlite-wal`, an antivirus scan).
  Removing a tried update's folder, an older build's unpacked app or a
  damaged copy now waits for it to be let go, as it was meant to: Node
  24.16 to 24.18 and 25.1 stopped at the first refusal instead of retrying,
  so an update could fail and a damaged copy couldn't be replaced. The
  executable and the updater remove these folders with `fs.promises.rm`,
  whose retries work in every supported Node.

- **A new household key is saved to your account when it's made** (#791).
  The device that starts using a new household key now saves it to your
  account in the same step. Before, if that device was lost or reset right
  away, signing in on another device with your backup code, password or
  passkey could leave sync paused for good.
- **The connection relay frees a tunnel handshake its client aborts**
  (#733). A home server that refused the relay's certificate left the
  connection open on the relay until Node's 120-second default, and the
  relay's `close()` waited for it. The relay now limits handshakes on its
  own name to the 10-second sign-in window and closes such connections when
  it stops. Stopping also waits (at most two seconds) for each home server
  to close its tunnel after GOAWAY 8 instead of destroying the socket
  straight after writing it, which could lose the GOAWAY or reset the
  connection (seen on Windows).
- **The Home screen panel keeps its Saved message** (#469). A background
  sync no longer redraws the panel when nothing it shows has changed, so
  the Saved confirmation or a save error stays visible.
- **Kin loads itself again if its start stops without an error** (#469,
  follows #594). On Edge for Windows a first start sometimes stopped with a
  few module requests that never finished and no error, which left only
  "Skip to content". The start-up guard now also reloads when nothing has
  finished loading for 8 seconds and Kin still hasn't started, with the same
  limit of two reloads in a row. A slow start that keeps loading is left
  alone, and so is one that stopped on a script error. If a slow third
  start shows "Kin didn't finish loading" and then finishes, the message
  goes away.

## v1.6.0 — Kin for Everyone

Released 2026-10-21 as `kin-v1.6.0`. This minor release makes Kin easier for
someone who rarely uses apps (epic #603, ADR 0021): easy mode with bigger
text and buttons and fewer things on screen, Help on every screen, household
features an admin can switch off for everyone, reporting a problem or
suggesting a feature from inside Kin (with optional forwarding to GitHub
issues), and setting Kin up for someone else with a printed sheet. It also
prepares Kin for Google Play (epic #527): an Android app, a public privacy
policy, the listing and Data safety drafts, Play graphics and a release
runbook.

### Added

- **Set up Kin for someone** (#612: #613, #614, #615; epic #603,
  [ADR 0021](docs/decisions/0021-kin-for-everyone.md) §4). A household admin
  prepares Kin for one person from People & devices: their name, who they
  are (Adult, Limited or Temporary), easy mode (on by default), the helper's
  name and a note. Kin makes a QR code, a link and a one-page "How to open
  Kin" sheet in large type (the QR code, the link and code, three plain
  steps, "If you get stuck, call Mikey" and when it ends) with a print
  stylesheet. Opening it: "Hi Rose — your family set this up for you" in
  easy mode, a password with Show password and a username chosen from her
  name, the wait for approval naming the helper, "Do these match?", then
  Today in easy mode with her name set and easy mode in her synced settings.
  The inviter still approves after comparing fingerprints (side by side in
  person, or by phone); there is no unattended pre-approval (THREAT-MODEL).
  The names travel only in a card sealed on the admin's device under a key
  carried in the link's fragment. **Server schema 27** adds
  `prepared_invitations` (forward migration from 26): a prepared invitation
  lasts 1 to 7 days, survives a restart, is single-use, and its claim waits a
  day for approval; at most three wait per household. Routes `POST` and
  `GET /api/pairings/prepared`; `POST /api/account/invitation` answers a
  prepared code with `prepared`. UX §42, PAIRING, IDENTITY.
- **Easy-mode sweep** (#639, story #638): Help's "Words on this page" now
  also covers the words a page shows at that moment, and in easy mode every
  button, menu, field and disclosure gets the tap size. Browser regressions
  `scripts/easy-sweep-regression.mjs` (every page in easy mode at 320 px and
  desktop: Help, 56 px controls, no unexplained word, switched-off features
  absent) and `scripts/setup-for-someone-regression.mjs` (the whole set-up
  flow in two browsers).
- **Easy mode** (#616: #617, #618, #619; epic #603,
  [ADR 0021](docs/decisions/0021-kin-for-everyone.md)): bigger text and
  buttons, fewer things on screen. Turned on in Household → Identity &
  appearance, or from a one-time offer on Today in the first week. It
  follows the member as synced setting 8 `easy-mode` (on this device only
  without private storage). The page scales by 125% (20 px base text,
  targets of at least 56 px), the tick and the header's icons show their
  words, focus is thicker, rows keep one clear action, the Undo line is
  larger, and the navigation keeps Today, Lists (To do, Shopping), Updates
  and Household plus whatever the person used in the last two weeks.
  Simple view wins when both are on. A plain-language pass of the page
  lines and the Household overview, and a glossary (`web/help/glossary.js`)
  that Help uses, with a test that flags Kin's own words on a screen unless
  its Help explains them. UX §41.
- **Help on every screen** (#620: #621, #622): a Help button beside every
  page's heading and in Quick add, item details and Shopping mode. It says
  what the screen is for, two or three things to do (with **Show me**, which
  points at the control), who sees it and the harder words it uses, and
  **Still stuck?**: message a household admin (Chat, or Handoffs where Chat
  is off) or report a problem (shown when the report dialog listens for
  `kin:report-problem`). A first-week tip on Today points at it. Every route
  and tab has its Help (a unit test checks).
- **Browser regression** `scripts/easy-mode-regression.mjs`: the tips, Help
  on every page and in Quick add, Show me, Still stuck, and easy mode's
  sizes, words, navigation and Undo line at 1280 px, 320 px and 200%, in
  dark mode, forced colours and reduced motion.
- **Report a problem, suggest something, and see what you've sent** (#630,
  #627, #635; [ADR 0021](docs/decisions/0021-kin-for-everyone.md) §3).
  Anyone can report a problem from Household, the keyboard help, Help, any
  error message or the lock screen: optional typed text, the device's
  diagnostics (each shown and removable) and, only if turned on, a cropped
  picture of Kin's screen drawn by Kin itself. A preview shows exactly what
  goes and where; nothing is sent without Send; offline reports wait in an
  outbox; each gets a reference number. Household admins can suggest
  features (Household › Features). What I've sent shows
  each one's status. A local diagnostic ring buffer (the last 50 codes,
  numbers only, in memory) is recorded at sync, engine, storage, render,
  route and unexpected-error sites. The service stores reports in **server
  schema 26** (`feedback`, `feedback_screenshots`) with routes `POST
  /api/feedback`, `POST /api/feedback/anonymous`, `GET /api/feedback/mine`
  and `GET /api/feedback/channel`, per-member and per-address limits,
  180-day retention and purge with member removal and household deletion;
  admin commands `feedback-list`, `-show`, `-set-status`, `-forward` and
  `-purge`; and optional forwarding to GitHub issues
  (`KIN_FEEDBACK_GITHUB_REPO`, `KIN_FEEDBACK_GITHUB_TOKEN`) with status
  following the issue. DEBUGGING's planned "export diagnostics" is replaced
  by this.
- **An Android app for Google Play** (epic #527; #529, #530, #535, #536,
  #537): `android/` holds a Trusted Web Activity that opens
  `https://kin.journeytocode.io` full-screen, with sharing into Kin (text,
  links, images and PDFs), the first four home-screen shortcuts, Kin's
  notifications delegated to the app (asking for Android 13's permission),
  Kin's splash and adaptive icon, and a Custom Tab when no browser supports
  TWAs. Package `kin.app`, set in one place; target API 36. Names, colours,
  share target and shortcuts come from the web manifest, the version name
  from `package.json`, and the pictures from `scripts/render-icons.mjs`.
  [ADR 0020](docs/decisions/0020-google-play-twa.md) records the origin, the
  package name, Play App Signing and the dependency exception (Google's
  `androidbrowserhelper` and the Gradle build, scoped to `android/`; Kin's web
  runtime stays dependency-free). [ANDROID](docs/ANDROID.md) covers building,
  versioning, the upload key and its recovery, the asset-links setup, and the
  owner's phone checklist.
- **CI builds the Android app**: a new `android` job builds an unsigned debug
  APK and App Bundle, checks the APK against the web manifest
  (`scripts/check-android-app.mjs`) and keeps both as an artifact. Signed
  release builds stay manual.
- **A public privacy policy** (#541, epic #527): `web/privacy.html`, served
  at `/privacy.html`, says in plain words what stays on your devices, what
  Kin's service stores and sees (your username, a check value for your
  password, membership, device keys, timing, counts and sizes, IP addresses
  for rate limits, push addresses if notifications are on), what Kin never
  does (ads, selling, analytics, reading content, AI), how to delete your
  account or household and how long things are kept. It opens offline and
  is linked from Household › Privacy & recovery and the README. Its contact
  address, `privacy@journeytocode.io`, is a placeholder to confirm.
- **Google Play listing and Data safety drafts** (#540, #541):
  [PLAY-LISTING](docs/PLAY-LISTING.md) has the name, descriptions, category,
  contacts, each Data safety answer with its reason and the open questions
  for the owner, a content rating draft and the target-audience (Families
  policy) choice.
- **Play graphics** (#540): `scripts/render-play-graphics.mjs` draws the
  1024 × 500 feature graphic, `play/feature-graphic.png`, from the icon
  geometry (with `--check`); `scripts/play-screenshots.mjs` captures Today,
  Shopping, This week, Chat and the journal of a made-up household at phone
  and 7- and 10-inch tablet sizes. The Kin verification workflow runs it
  only on **Run workflow** (`play-screenshots` job) and uploads
  `kin-play-screenshots`. The PNG reader in `scripts/render-icons.mjs` now
  reads every row filter and the encoder writes RGB as well as RGBA.
- **A Play release runbook** (#545): [PLAY-RELEASE](docs/PLAY-RELEASE.md)
  covers the one-time setup (developer account, app creation, Play App
  Signing, asset-links fingerprints, app content, listing), the 14-day
  closed test with 12+ testers, production submission, when a change needs a
  Play release rather than a web deploy, version codes, staged rollout and
  rollback. Linked from [RELEASES](docs/RELEASES.md).
- **Household features** (#623, #624, #625, #626, epic #603,
  [ADR 0021](docs/decisions/0021-kin-for-everyone.md) §2): **Household ›
  Features** lists Chat, Fridge, Meals, Routines, Taking turns, This week,
  Talk later, Store sections, Shopping mode, Maintenance, Notes & reference,
  Sitter page, Journal and Just for me, each with a plain sentence. A
  household admin switches them off for everyone and saves with a fresh
  passkey or password; other members see the list read-only with "Ask a
  household admin". Off means hidden, never deleted: the feature leaves the
  navigation, segment links, Today, This week, Search, Quick add's repeat,
  the share sheet, chat actions, shortcuts and the command palette on every
  member's device, its routes open Today with a calm line, and members see a
  one-time note on Today. The service keeps the set (server schema 25,
  `households.features_off` and `features_revision`), changes it through
  `POST /api/household/features/options` and `/finish` (unknown bits and
  stale revisions refused), delivers it as `features` in `/api/sync/status`,
  and refuses the Chat and Fridge routes while they are off. Devices keep
  the last set (`kin.household-features`); a household that doesn't sync
  keeps its own. `ctx.features.routeAvailable(route)` is the one question
  other surfaces (easy mode, Help) ask. Browser regression
  `scripts/household-features-regression.mjs`.

### Fixed

- `.gitignore`: `/.kin-data/` and `/deploy/.env` had been joined into one
  line, so neither was ignored. Signing keys (`*.jks`, `*.keystore`,
  `keystore.properties`) and Android build output are now ignored too.

### Compatibility

- Server schemas 25–27 (household features, reports and suggestions,
  prepared invitations) are forward migrations; an earlier server refuses
  the newer database, so keep a pre-upgrade backup if you might roll back.
- Household features (the `features` field in `/api/sync/status`), reports
  (the device's own `kin-feedback-outbox` database, version 1) and prepared
  invitations (card format 1, carried in the link's fragment) are listed in
  [V1.0-COMPATIBILITY](docs/V1.0-COMPATIBILITY.md) under v1.6.0. Easy mode
  is synced setting 8. No household event kind, replay protocol (still 24),
  sync envelope, household export or account vault format changes.
- A device on an earlier release ignores household features and shows
  everything, except that Chat and the Fridge stop working for it while
  they are switched off, as for "No access". It joins from a prepared
  invitation like any other, with the name typed by hand, and never sends a
  report.
- The Android app is built in CI but not yet published on Google Play; its
  `versionName` follows `package.json` and its `versionCode` stays 1 until
  the first upload.

## v1.5.0 — One Account and Private Spaces

Released 2026-10-21 as `kin-v1.5.0`. This minor release gives each member one
account across their devices (ADR 0018) and private space of their own
(ADR 0019): a username and password at first run, an optional passkey and a
backup code, signing in on a new device without another one present, moving
an existing household to accounts, a personal journal, a Just for me list,
and reminders and settings that follow the member. It also finishes the
home-screen shortcuts and app-icon count, calms the unlock wording, links a
Google Play app and recovers a start-up cut short on Edge.

### Added

- **App link for a Google Play app** (#532): the service serves
  `/.well-known/assetlinks.json` when `KIN_ANDROID_PACKAGE` and
  `KIN_ANDROID_CERT_SHA256` are set, so a Play Store wrapper can open Kin
  without an address bar. Off (404) by default.
- **Move to an account, without starting over** (#574, #575, #576, [ADR
  0018](docs/decisions/0018-account-key-vault.md) "Migration"): if you set
  Kin up with a passkey and a backup key, Today now calmly invites you, once,
  to choose a username and password so you can sign in on your other
  devices (`Not now` puts it away for a week). One touch of your passkey
  confirms it; your device makes your account's key vault from what it
  holds, and where your passkey supports it, the passkey alone signs you in
  on a new device (no password-only way in is ever stored). Your password
  unlocks this device too; your passkey and backup key keep working. Your
  other old-style devices offer `Use my account here`. Interrupted setups
  pick up where they stopped. Once you have a backup code, Security says the
  per-device backup key is no longer needed. Members who decline keep using
  Kin exactly as before.
- **Unlock with your passkey offline** (#551, #552, #553): on the train with
  no signal, your face or fingerprint opens Kin: the passkey unlocks with a
  challenge made on the device, user verification required. Online unlock
  is unchanged. A documented contract change (CRYPTOGRAPHY, "Offline passkey
  unlock").
- **Your private things in your own export** (#493, #494, #495, [ADR
  0019](docs/decisions/0019-member-private-log.md)): Security → Backup and
  move → `Save my private things` saves your journal, Just for me list,
  reminders and settings (and journal photos, as many as fit in 64 MiB; the
  rest are named) in a file only you can open, on your devices or with your
  backup code. `Restore my private things` puts them back only for you,
  without duplicates. Household exports never include them.
- **Remove a passkey; start over on a browser** (#592 follow-ups): each
  passkey under Security has `Remove this passkey` (after your password;
  never your last way in: removing the last one brings your password back).
  A device whose passkey no longer works offers `Start over on this
  browser`, which clears Kin from that browser after a clear warning and
  opens Sign in, instead of asking you to clear site data.
- **Add a passkey: it signs you in alone, or require password and passkey**
  (#560, #561, #562, [ADR 0018](docs/decisions/0018-account-key-vault.md)
  D3/D4): once you've added something, Today calmly offers a passkey (and
  Security always does). Adding it asks for your password once, then your
  face, fingerprint or screen lock; from then on your passkey signs you in
  on a new device by itself and unlocks Kin on this one, and your password
  alone no longer opens your account anywhere new, so a stolen copy of Kin's
  service holds nothing a password guess opens. Household admin actions ask
  for the passkey again. **Require password and passkey** (Security, off by
  default) makes a new-device sign-in ask for both. **Change password** is
  under Security too: your account and this device move to the new password
  in one step, and your other devices follow when they next sign in. The
  service now refuses any set of vault wrappers that would let a password
  alone open the vault beside a passkey, or a passkey alone beside
  require-both; changes swap wrappers in one transaction, after a fresh
  password check. No server schema change.
- **A backup code for your account** (#571, #572, #573): one printable code
  (8 groups of 7 letters and numbers, with a typo check), offered on Today
  after your first week and under Security, never at sign-up. It signs you
  in on a new device as a third way in (limited like a password), and then
  you choose a new password. Making a new one stops the old one at once.
  Exports from a device without a backup key (one set up with a password or
  a passkey) now work and open with the code; exports made with a device's
  backup key keep opening as before, and Kin no longer asks a member who has
  a backup code for a per-device backup key.
- **Sign in on a new device: add it, or replace an old one** (#568, #569,
  #570, [ADR 0018](docs/decisions/0018-account-key-vault.md)): on a phone or
  browser with no Kin on it, `Sign in` with your username and password (or a
  passkey, once your account has one) and say whether this is a new device or
  replaces one of yours (that device is signed out for good, with a clear
  warning). No other device needs to be there: the browser gets a
  ten-minute, single-use new-device permission (never a session), opens your
  account vault, certifies its own keys with your certification key from the
  vault, and installs the household's keys, then lands on Today. Your
  devices endorse your certification key automatically, and the household's
  devices accept a device it certified, pinning that key per member. Losing
  every device is now recoverable with your password. Pairing from another
  device still works. No server schema change.
- **Just for me: a private list on all your devices** (#510, #511, #514,
  #517): Lists › Just for me holds private to-dos and short notes only you
  can see, with an optional date, complete and reopen, and delete with
  Undo; it works offline and syncs between your devices through your
  private stream. Dated ones show on your own Today and This week, marked
  "Private" (a setting, on by default; never in Simple view or household
  search). **Share with the household…** moves an item to To do after a
  confirmation naming who will see it; **Make private** moves something you
  added into your list, with Undo. Both are safe to retry after a failure.
  Engine: private kinds 110–118, KPRV section 11 and the
  `kin_private_execute` export.
- **A personal journal** (#496: #497, #501, #504, #507, [ADR 0019](docs/decisions/0019-member-private-log.md)):
  each member can write dated entries, with an optional title, plain text and
  up to ten photos, on a Journal page reached from Household's "Just for
  you" and marked "Only you can see this". Entries are sealed in the
  member's private log and sync to their own devices only; photos are sealed
  per member as private blobs. A draft is kept while Kin is unlocked; delete
  and photo removal offer Undo. Local search, a month jump and a quiet "On
  this day" on the journal page only. The share sheet offers "Add to my
  journal", and a "New journal entry" home-screen shortcut opens the editor.
  Never in household search, Today, chat or exports; no streaks, prompts or
  counts. Private kinds 101–104 (kind 100 reserved) through `kin_private_execute`,
  KPRV section 101, and server schema 24 (`private_blobs`).
- **A gentle first run: your name and a password, then you're in** (#557,
  #558, #559, [ADR 0018](docs/decisions/0018-account-key-vault.md)): a new
  device asks at most three screens (start or join; your name and the
  household's name or invitation code; a username and password) and lands
  on Today, with no backup key or security choices up front. The password
  unlocks the device daily, offline, and signs it in; the service stores only
  a username and an Argon2id verifier of a key derived from the password.
  The member's encrypted account vault is created on their first device and
  kept current. Joining still needs the inviter's approval. A member with no
  passkey yet confirms admin actions with a fresh password. Server schema 23
  (`members.username`). The passkey and backup-key setup stays available as
  "Set up with a passkey instead".
- **Private storage for each member, groundwork** (#485, #489, [ADR 0019](docs/decisions/0019-member-private-log.md)):
  a member key kept only in the member's account vault (vault contents
  format 2) and rotated when one of their devices is revoked; a private log
  in the engine (kinds from 100, KPRV), a private relay stream on the service
  keyed by member (server schema 22, the admin's "private storage for
  children and teens" setting, purge on member removal), and a private log
  store and sync pass on the device. Nothing visible yet: the pass stays off
  until the vault key is kept on the device (#557) and the journal, list and
  reminder stories add the first private records.
- **My reminders and settings on all my devices** (#520, #521, #522, #523,
  #524, #525, #526): with private storage on (members with an account), a
  reminder set on one device goes off at the same instant on each of the
  member's devices that allows notifications, and dismissing it on one
  clears it on all of them; a reminder set in another time zone also says
  the time where it was set. Theme, text size (new: Standard, Large,
  Larger), Kin's own reduced-motion setting (new), whether reminders show as
  notifications (new) and the app icon count follow the member, last change
  winning per setting; **Use different settings on this device** keeps a
  shared screen such as a kitchen tablet to itself. A device's own
  reminders move into private storage once, without duplicates. Members set
  up with a passkey and backup key keep everything on the device as before,
  with one line offering an account. Private kinds 120, 121 and 130, KPRV
  sections 12 and 13, made through `kin_private_execute` (no server
  change).
- **Home-screen shortcuts, finished** (#471, #472): long-press the installed
  icon for **Add to shopping**, **Add a task**, **This week**, Shopping, Chat
  and Today. The Add shortcuts open Quick add on Shopping or To do with the
  title field focused. A locked Kin unlocks first, then lands; a shortcut
  used while Kin is open lands at once. Simple view lands on Today, and a
  Temporary member stays where the shortcut took them. Each shortcut has
  its own 96 and 192 px PNG icon (Android ignores SVG-only ones), and the
  app now has 192 and 512 px PNG icons and a maskable 512 px icon, all drawn
  by `scripts/render-icons.mjs` with Node built-ins only and cached for
  offline use.
- **Count on the app icon** (#476): an optional number on the installed
  app's icon, set per device under Notifications: Off (the default), Unread
  messages, or Unread messages and my things today. Never shows content;
  Lock and sign-out clear it.
- **Encrypted key vault on the service, groundwork** (#564, [ADR 0018](docs/decisions/0018-account-key-vault.md)):
  the vault and wrapper formats, password/passkey/backup-code key
  derivations, server schema 21 with the vault routes (own member, trusted
  device, compare-and-set, rate-limited downloads) and the Argon2id password
  verifier helper, and re-sealing a member's vault when a device installs a
  new epoch key. Nothing visible yet: no vault is created until the first-run
  story.

### Changed

- **Kin loads itself again if its start was cut short** (#594): on Edge for
  Windows a page load sometimes had its module requests cancelled by the
  browser part way, which left a blank page with only "Skip to content". A
  small start-up guard (`web/boot-guard.js`) now notices and loads the page
  again, at most twice in a row, then offers Try again. A load that wasn't a
  refresh stays locked: the guard's reload never resumes it (#351).
- **Calmer unlock until accounts arrive** (#563): screens call the recovery
  key the **backup key for this device** ("Each device has its own"; stored
  format unchanged, #578); right after setup, once the device is in a
  household and online, Today asks "Unlock with your face, fingerprint or
  screen lock next time?" with Turn on and Not now (#577); new
  password-manager entries are named for the device ("Kin backup key — Chrome
  on Android (K-7F3A)"), the unlock form asks for that entry and names it
  under the field, older "Kin recovery key" entries still match, and after a
  backup-key unlock a one-time suggestion offers passkey unlock (#579).
- **The unread chat count on the app icon is now opt-in** (#476): it used to
  appear wherever the browser supported it; now it shows only after a member
  chooses it under Notifications. The "Quick add" shortcut is now "Add a
  task" and opens To do (its address is unchanged, so existing installs keep
  working). A household's published install identity no longer puts its own
  icon on every shortcut; each keeps Kin's shortcut icon.

### Security

- The one-wrapper vault routes (`PUT`/`DELETE /api/account/vault/wrappers/<id>`)
  now need your current password or a fresh passkey, like every other change
  to how your account opens.
- A password changed on another device: at its next unlock with a
  connection, a device asks for the new password before opening, and
  switches to it. Offline, the old password still opens that device until it
  is online (THREAT-MODEL).

### Compatibility

- Server schemas 21–24 (account vaults, the private relay and its policy,
  usernames, private blobs) are forward migrations; an earlier server refuses
  the newer database, so keep a pre-upgrade backup if you might roll back.
  Once a member has endorsed their certification key, don't roll the server
  back.
- Adds a member's private log (kinds 100–199, of which 100–104, 110–118, 120,
  121 and 130 are used; replay protocol still 24), the KPRV result and
  `kin_private_*` exports, account vault contents format 2, device
  authorization certificate version 2, a `password` wrapper in the local
  security manifest, and the member's private export KPEX 1. Each is listed
  in [V1.0-COMPATIBILITY](docs/V1.0-COMPATIBILITY.md) under v1.5.0; the
  household history, sync envelope and household export formats are
  unchanged.
- A device set up with a password must not be downgraded below v1.5.0. A
  device on an earlier release pauses sync when it meets a version 2 device
  certificate until it updates; households where nobody signs in on a new
  device are unaffected.

## v1.4.0 — Fridge, Meals and Household Helpers

Released 2026-10-20 as `kin-v1.4.0`. This minor release adds the family fridge,
Meals, Simple view for children, Talk later in Chat, undo and redo, and a set of
everyday household helpers: share into Kin, shopping mode with store sections,
bringing a list into Kin, This week, the sitter page and taking turns on
routines.

### Added

- **Taking turns on routines** (#428, [ADR 0016](docs/decisions/0016-routine-rotations.md)):
  people take turns at a routine in an order you choose; the turn passes when
  it's done, with Skip to next and Give this turn to…, and Today shows whose
  turn it is. No scores.
- **For the sitter** (#441, [ADR 0017](docs/decisions/0017-sitter-page.md)):
  an Adult picks notes, contacts and routines for a babysitter, carer or guest;
  a Temporary member lands on **For you**, which shows them live, with phone
  numbers as tap-to-call links.
- **This week** (#416): from Today, the next seven days in one list —
  planned items, routines, dinners and maintenance due — with complete,
  Undo and Move to… another day.
- **Bring a list into Kin** (#452): paste several lines into a capture field,
  or import a CSV or text file from another app, preview the rows (repeats
  and existing items left out) and add them to To do or Shopping, with dates
  and done states where the file has them.
- **Store sections** (#411, [ADR 0015](docs/decisions/0015-store-sections.md)):
  name the parts of the shop in the order you walk it, give items a section,
  and shopping mode groups the list that way (Other last). Staples keep
  their section when replenished. Event kinds 66 and 67; older devices pause
  sync until updated.
- **Shopping mode** (#403): Start shopping opens the list for the shop —
  big checkboxes, ticked items into "In the basket" (Undo applies), and the
  screen kept on while you shop where the browser allows.
- **Share into Kin** (#389): choose Kin in another app's share sheet to add a
  link, text, photo or PDF to To do, Shopping, a note, a handoff or Chat,
  after a preview. The content never reaches the server. Home-screen
  shortcuts: Quick add, Shopping, Chat and Today.
- **Talk later** (#312, [ADR 0014](docs/decisions/0014-talk-later.md)): any
  message can go on a **To talk about** list in Chat, marked in the
  conversation, then be marked talked about, reopened or removed. The older
  Talk topics sit in the same list. It's a side column at 1180px and wider,
  and a panel from the chat toolbar elsewhere, its count in words. A flag is
  a new chat event (kind 65), so members without chat access never see it;
  they find the older topics under Handoffs.
- **Updates has two tabs** (#313): Handoffs and Chat. The Talk tab is gone;
  old Talk links open the To talk about list.
- **Chat on a phone** (#310, #311): Chat fits the screen, with the message
  list the only thing that scrolls, and opens at the newest message; Jump to
  latest shows when you scroll up. The composer is one row ([+] [message]
  [emoji] [Send or Voice]) and stays above the keyboard and the bottom bar.
  Message actions open in one sheet: a long press or ⋯ on a touch screen (a
  bottom sheet, reactions first), ⋯ or right-click with a mouse.
- **Undo and redo** (#315): after adding, completing, reopening, archiving,
  planning or pinning an item, or adding, completing or deleting a routine,
  a toast offers **Undo**, then **Redo**; Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z (or
  Ctrl+Y) do the same outside text fields. Each undo appends ordinary
  reversing changes that sync; history is never rewritten. It is refused, in
  plain words, when the thing changed since. Kept in memory for the session;
  locking clears it.
- **Delete routine** (#314) replaces "Stop repeating": no confirmation, the
  toast's Undo brings it back with its schedule, owner and today's
  completion. On a phone it lives in the row's ⋯ menu.
- **Simple view** (#341, [ADR 0013](docs/decisions/0013-simple-view.md)): a
  household admin turns on a calmer layout for a Limited member (People &
  devices, with their passkey). The child's Kin then shows only Today, Chat
  and the Fridge: big cards for their own things today with a picture, a
  large Done that becomes Undo in place, and tonight's dinner. Nothing is
  counted. It is a layout, not a lock: the service enforces only the switch
  and Chat and Fridge access. Server schema 20 (`members.simple_view`), key
  database version 6 (the cached layout, so an offline unlock stays simple).
- **Item pictures** (#347): Adults give an item one emoji in its details; it
  shows beside the item's text and large in Simple view. Event kind 64; older
  devices pause sync with "update Kin" rather than drop it.
- Assignee labels use members' preferred names, else "Household member N",
  never "Household adult N" for a child (#344).
- **Meals** (#333, [ADR 0012](docs/decisions/0012-meals.md)): Lists → Meals
  plans the week's dinners, Monday to Sunday, from the household's own
  recipes or "Something else", with who's cooking (anyone; nothing is
  counted). Recipes are a name, ingredients one per line and notes; an
  ingredient that exactly matches a Staple is linked to it. **Add ingredients
  to Shopping** adds what's missing, re-adds linked Staples and skips what's
  already listed, so adding twice never duplicates. Today shows Tonight's
  dinner. Meals are household events (kinds 59–63); older devices pause sync
  with "update Kin" rather than drop them.
- A refresh keeps Kin unlocked in the same tab, including an accidental
  pull-down on a phone (#351, #354). Closing the tab, Lock, automatic lock and
  a lock from another tab still lock Kin, and the inactivity clock carries
  over. The unloading tab leaves a one-use, two-minute ticket sealed with a
  non-extractable key; see [ADR 0010](docs/decisions/0010-reload-resume.md).
- Security → Automatic lock → **Stay unlocked when I refresh this tab**, on by
  default (#355).
- **The family fridge** (#317, [ADR 0011](docs/decisions/0011-family-fridge.md)):
  Household → Fridge is a shared 3:4 board the household draws on with a
  finger, pen or mouse, with an eraser and undo/redo, on phones, tablets and
  desktop (#320, #321). Drawings live in a third encrypted log beside the
  household history and chat (event kinds 52–58, KBRD, #319) and travel in
  their own relay stream (server schema 18). Older devices never see them.
  Magnets (emoji, Kin-drawn or a short note) move by keyboard, menu or drag
  (#322); clearing asks first and anyone can bring it back (#323); the
  household admin decides whether Limited and Temporary members draw, look
  only or have no access (#323, server schema 19). Encrypted exports carry
  the fridge and restore brings it back (#363). On a landscape tablet the
  tools move to a side rail and the door takes the height, with optional full
  screen; automatic lock is unchanged and the screen says how it locks (#324).

### Changed

- The page no longer triggers the browser's pull-to-refresh where the browser
  allows turning it off (#353).

### Compatibility

- Adds household event kinds 59–64 and 66–70 (Meals, item pictures, store
  sections, taking turns, the sitter page), chat event kind 65 (Talk later),
  and the fridge's own board log with kinds 52–58, all schema 1 with replay
  protocol still 24. Each is listed in
  [V1.0-COMPATIBILITY](docs/V1.0-COMPATIBILITY.md) under v1.4.0; v1.0–v1.3
  formats are unchanged.
- Server schemas 18–20 (fridge relay, fridge access policy, Simple view) are
  forward migrations; an earlier server refuses the newer database, so keep a
  pre-upgrade backup if you might roll back. The key database goes to version 6.
- A device on an earlier release that receives one of the new household kinds
  pauses sync with "update Kin" and keeps its data until it updates. An export
  that includes the fridge can't be imported by an earlier release.

## v1.3.0 — Member Names and Clearer Setup

Released 2026-10-19 as `kin-v1.3.0`. This minor release completes the member
identity and device pairing epic (#218) and ships the first slices of the
usability epic (#261). The #261 changes are built from the epic's written
direction; the tester sessions it calls for (#262, #269) have not run yet.

### Added

- Each member can choose the name their household sees ("Mikey") with **Set my
  name** on the household panel (and in People & devices for Adults), with
  device sync on (#224, #225). The name is a new encrypted household event,
  `MEMBER_NAMED`, that always names its own author, so nobody can name another
  member. It is presentation only: it never changes a member ID, role, device
  trust or push filtering.
- A device without a nickname shows its owner's name beside its automatic name,
  "Mikey · Chrome on iPhone"; a nickname always wins and is never overwritten.
- **Invite another person** (role chosen first) and **Add my device** are
  separate, explained choices (#219, #222). Both sides of a pairing say which
  path is in progress, and a code whose real purpose contradicts the chosen path
  can't be activated until the person acknowledges the switch (#223).
- A first-use "Welcome home" card, "What would you like to remember?" with a
  line saying where an item goes, plain one-line descriptions under each
  destination, and next-step text while a device waits for approval (#263–#266).

### Changed

- With sync on, a capture says "Saved here. Waiting to sync." until a sync cycle
  leaves nothing unaccepted in this device's outbox, then "Saved and sent to
  your household." Completing, reopening or archiving names the item and says
  how far the change has gone. Nothing claims another member received it (#267).
- First-run choices use plainer labels: Start a new household, Join my
  household, Add my device, Sign in using my phone (#264, #271).

### Fixed

- On a device without household sync, the fridge showed its drawing tools
  and a blank line under the board, so it looked drawable and did nothing
  (#372). The tools now wait for sync, and the board says the fridge is
  shared through sync, with a link to People & devices.
- Exporting a synced household refused its own fridge and chat ("Connect to
  your household…") because the export expected the household ID in a
  different form; restoring such an export now opens the right fridge and
  chat (#372).
- People & devices could be replaced mid-load by a pairing poll or household
  refresh from the previous view, losing the device list (#304, #305, #307).
- The setup screen hides "Sign in using my phone" again while a claim is
  pending.
- A name that would pass for "You" can't be saved and isn't shown for others.

### Compatibility

- Adds event kind 51 `MEMBER_NAMED` (schema 1, replay protocol still 24), the
  `kin_member_names` export with its KMNM v1 result, and KCMD action 51, listed
  in [V1.0-COMPATIBILITY](docs/V1.0-COMPATIBILITY.md) under v1.3.0. No server,
  route, schema or storage change; v1.0–v1.2 formats are unchanged.
- A device on an earlier release that receives a name pauses sync with an
  "unsupported" error and keeps its data until it updates. Nothing is written
  until a member sets a name.

## v1.2.0 — Household Chat

Released 2026-10-19 as `kin-v1.2.0`. This minor release adds one household chat
room beside Talk, under Updates → Chat, as decided in
[ADR 0008](docs/decisions/0008-household-chat.md) (#104, #105). Chat is for the
members of one household only: there are no conversations with people outside
it, no public rooms and no anonymous sharing.

### Added

- Text and emoji messages, with editing, replies, mentions, emoji reactions and
  pinned messages.
- Photos and files, voice messages, quick polls, and message search.
- Read receipts, typing indicators and "online now". Each is visible to the
  members it applies to, each member can switch off sending their own, and none
  is kept as history.
- Chat access policy: everyone can chat by default, including Limited and
  Temporary members. A household admin can restrict either group.
- Delete for yourself, or delete for everyone as the author. A household admin
  can delete any message for everyone, shown to members as "Removed by an admin".
- Chat is included in encrypted exports and restores.

### Changed

- Message text and attachments are stored as encrypted content blobs outside the
  event log, so deleting a message removes its content from the relay and every
  device. The log keeps the message event only.
- Chat has its own event log, relay stream and cap, separate from household
  history.
- Short-lived signaling has a separate, closed boundary (ADR 0009). No calls are
  built.

### Compatibility

- Adds the chat formats listed in [V1.0-COMPATIBILITY](docs/V1.0-COMPATIBILITY.md)
  under v1.2.0. Existing v1.0 and v1.1 formats are unchanged, and every release
  still reads them.
- Server schemas 12 through 17 are forward migrations. Keep a pre-upgrade backup
  if rollback matters.

## v1.1.2 — Private Household Branding

Released 2026-10-18 as `kin-v1.1.2`. This patch shows the private household
name and icon in the unlocked shell and keeps that identity synchronized across
unlock, restore, join, sync, and leave transitions. Locked and unassociated
surfaces retain generic Kin branding. It does not change Kin's persistent
formats, protocol versions, or v1.0 compatibility commitment.

### Changed

- The unlocked app header uses the household's private name and icon while
  preserving generic Kin branding on the lock screen.
- Restore, join, unlock, sync, and leave flows now refresh or clear both the
  shell brand and installed-app identity at the appropriate boundary.
- Household appearance projection and session lifecycle tests cover stale-name,
  stale-icon, locked-state, and leave/rejoin behavior (#231–#233).

### Verification

- Passed 1,024 Node tests, 261 Rust tests, release WASM/static comparison, and
  version consistency.
- Passed the full browser, encrypted-storage, security-UI, virtual-passkey, and
  154-assertion household-authority suites on the release promotion gate.

## v1.1.1 — Member and Notification Clarity

Released 2026-10-18 as `kin-v1.1.1`. This patch makes the People & devices
surface accurately distinguish household members from their paired devices,
separates invitation from same-member device enrollment, and makes device trust,
push recipients and delivery diagnostics explicit. It does not change Kin's
persistent formats, protocol versions, or v1.0 compatibility commitment.

### Changed

- People & devices groups each member's paired devices under that member and
  labels device trust separately from member roles.
- People & devices exposes separate invitation and same-member device-enrollment
  actions and labels devices Trusted or Untrusted.
- Notification settings identify which other member devices can receive a
  content-free push and distinguish subscription state from delivery outcome.

### Verification

- Added an identity/pairing acceptance matrix covering member/device identity,
  household authority, and notification-recipient behavior (#221, #226–#228).
- Expanded household, notification, server-push, documentation, narrow-screen,
  and Untrusted → Trusted browser regressions.
- Made the sandboxed-service integration test tolerate Windows' brief delay in
  releasing SQLite handles after a process tree exits, with a bounded cleanup
  retry.

## v1.1.0 — Connected Household Devices

Released 2026-10-18 as `kin-v1.1.0`. This release adds device names and
nicknames, household identity on installed home screens, opt-in content-free
push notifications, a sandboxed Node service, and QR pairing/phone-approved
computer sign-in while preserving the v1.0 compatibility commitment.

### QR pairing and signing in with a phone (#93)

- **QR codes, written and read by Kin itself.** The engine encodes and
  decodes QR codes in Rust (`rust/src/qr/`, byte mode, level M, versions
  1–10) with a bounded amount of work per camera frame. `<kin-qr>` draws a
  code, beside its typed alternative where there is one; `<kin-qr-scanner>` turns the camera on
  only when tapped, stops it on every way out, and accepts only this Kin's
  own links. No frame is stored or sent.
- **Invite by QR code (#97).** A waiting invitation shows a QR code for
  `/pair#code=…`. The code rides in the URL fragment, which never reaches the
  server; opening or scanning it only fills in the join screen. The QR code
  goes as soon as the invitation is claimed, expires or is revoked.
- **Sign in on a computer with your phone (#98).** On the computer, "Sign in
  with your phone" shows a QR code. On the phone, People & devices → Add a
  computer → Scan shows the computer's name and "Only approve a computer
  that's in front of you."; approving with a passkey shows a 6-digit code to
  type on the computer. A new computer becomes one of your devices with the
  household's history; a computer that's already yours is signed back in.
  Adults only. New service routes under `/api/link/requests` (#99).
- **The code binds the phone.** The phone's random code comes with a tag
  keyed by the code and a nonce only the QR code carries; with the right
  code the computer receives the tag, checks it and pins the phone's key, so
  neither the QR code alone nor the service can substitute a device.
- **Production camera access.** Kin's response policy permits camera capture
  only for its own document; microphone, geolocation and cross-origin camera
  access remain disabled. A real-server regression covers the policy, and the
  scanner was exercised on a physical Moto G.
- **Limits.** A sign-in QR code needs an origin of at most 56 bytes. The
  decoder can miss very small (version 1) codes seen at an angle; Kin's links
  are far larger. Opening a computer sign-in QR in the system Camera app while
  Kin is locked can lose the explanatory handoff after recovery unlock; open
  Kin and use People & devices → Add a computer instead.

### Push notifications (#85)

- **Per device, opt-in.** People & devices → Notifications on this device:
  turn on (the browser asks only then), mute for 1 hour, 8 hours or until
  turned back on, or turn off. Clear messages for unsupported browsers,
  iPhone/iPad outside the Home Screen, and notifications blocked in settings.
- **Content-free and calm.** "Something new in Kin" (or the household's
  published name), to other members' devices only, at most one per device
  every two minutes. Nothing about delivery or reading is recorded.
- **No dependencies.** Web Push with VAPID (RFC 8292) and RFC 8291 encryption
  on `node:crypto`, checked against the RFC's test vector. Only the major push
  services are contacted.
- **Server schema 11** stores subscriptions and the VAPID key pair. Revoking a
  device, removing a member, signing out of that browser or deleting the
  household deletes subscriptions, and so does a push service reporting one
  will never work (400, 404, 410, 413). A 401 or 403 (the service's own VAPID
  signature refused) is logged as `push_rejected_by_service` and keeps them.
  Development databases created from an early build of this branch, before
  `muted_indefinitely` was added to schema 11, need to be recreated.
- **Needs a VAPID subject.** The server's `https` origin or `KIN_PUSH_SUBJECT`
  (`mailto:` or `https:`); without one (a development server on
  `http://localhost`) the section says notifications aren't set up.

### Service sandbox (#106)

- **Node's permission model.** The service now runs with `--permission`: it can
  read the app directory and read and write only its data directory, and
  cannot start processes or workers or load addons. `server/start.mjs` starts
  it that way (`npm start`, `run.sh`, `run.ps1`, the container and Railway),
  and the service refuses to start otherwise. `npm run dev` stays unsandboxed
  because Node's watch mode needs a child process.
- **If you start Kin your own way** (a systemd unit, a script running
  `node server/server.mjs`), switch it to `node server/start.mjs`: the service
  now refuses to start outside the sandbox.
- `node:sqlite`'s own busy timeout replaces the pragma, and every transaction
  checks SQLite agrees about whether one is open.
- New routes use `URLPattern`; locks and stores support `using`.
- The verification gate gives every Node test a two-minute timeout.

### Household name and icon on home screens (#78)

- **Opt-in.** In Identity & defaults → Home screen, a household admin can show
  the household's name and icon on installed apps instead of "Kin": a short
  name, an optional description, and an icon that is the household name's
  first letter on the household colour or an uploaded image.
- **Plainly stated.** Before the first publish the panel explains that the name
  and icon are stored by the Kin service without encryption, and asks the admin
  to confirm. Everything else stays encrypted; the encrypted household settings
  are unchanged.
- **Only your devices.** The manifest and icons are served per device, from the
  household's trusted devices' cookie; everyone else gets Kin's. "Stop showing"
  deletes the copy, as does deleting the household.
- **Updates in place.** The app's identity (`id`, start URL, scope) never
  changes. Computers and Android pick up changes on their own; iPhone and iPad
  need the app added again.
- **Server schema 10.** New tables with a forward migration from 9. A v1.0
  server can't open a schema-10 database, so keep the pre-upgrade backup if you
  might roll back.
- The service worker no longer caches the manifest.

### Device names and nicknames (#71)

- **Nobody types a device name.** Creating or joining a household names the
  device after its browser and system ("Chrome on iPhone"; "iPhone" in the
  installed app) and says so in one line.
- **Nicknames.** Trusted devices now groups devices by member, marks the
  device you're holding, and lets you rename your own devices inline (up to
  32 characters, or remove the nickname). A device that hasn't synced a name
  yet shows as "New device" with the start of its sync code.
- **Private by design.** Device names are encrypted household events: new
  event kinds 42 `DEVICE_DESCRIBED` and 43 `DEVICE_NICKNAMED`, read through
  the new `kin_device_names` export (KDEV v1). Names that could hide
  characters are rejected. The replay protocol stays 24 and no frozen format
  changes ([compatibility](docs/V1.0-COMPATIBILITY.md#additions-since-v10)).
- **The server keeps only automatic names.** Any other label is stored as
  "Device", and labels typed before v1.1 are reset to "Device" when the
  service starts.
- **Update prompt.** A device that receives changes from a newer Kin now says
  to update Kin on that device; its saved information stays.
- **Mixed versions.** As soon as a v1.1 device syncs, a v1.0 device in the
  same household pauses sync until it updates; its data stays.

## v1.0.0 — Stable Kin Platform

Released 2026-10-17 as `kin-v1.0.0`, with the release candidate
`kin-v1.0.0-rc.1` on the same commit. Kin's first stable release.

**What's in it.** The last release was v0.10.3. Everything since then
ships in v1.0.0, per the owner's
[review-gate decisions](docs/audits/V1.0_REVIEW_GATES.md):

- the tagged review lines v0.11.x through v0.20.x;
- the v0.21.0–v0.47.0 development candidates, which were never tagged or
  published (each entry below says so);
- the unversioned desktop workspace and the performance refactor
  (under *Included* below);
- the v1.0 readiness work listed next.

**Compatibility.** v1.0 freezes its storage, sync, export and server formats
and promises that every v1.x release keeps reading them; see the
[v1.0 compatibility commitment](docs/V1.0-COMPATIBILITY.md). It makes no
promise for data created before v1.0: start fresh. What v1.0 does not protect
against is listed under
[known limitations](docs/THREAT-MODEL.md#known-limitations-at-v10).

### New since v0.47.0

- **Quick add** from anywhere, with partial-save recovery; recurring tasks can
  be created from Quick add, Today and Routines.
- **Today** is an actionable dashboard.
- **Keyboard shortcuts and a command palette.**
- **Bulk actions** with safe undo.

### Setup and devices (from the v1.0 reality check, #163)

- Setup no longer asks you to retype the recovery key. You confirm you saved
  it, and the browser can offer to save it as a password named for its label
  ("Kin recovery key K-7F3A"); recovery unlock can then autofill it.
- iPhone and iPad browsers show Home Screen install steps before setup,
  because the installed app keeps its own data, separate from the browser.
- New devices are named automatically ("Chrome on iPhone"), with an optional
  change.

### Sync and data

- Offline edits survive another device archiving the same item (#151).
- Key-grant epochs are taken only from the signed package (#152).
- Events another device sent that this one can't apply yet are kept
  (encrypted), retried when new history arrives, and shown as needing review
  instead of being dropped (#153).
- Key rotation never reuses a key already wrapped for a device that has since
  left (#176).
- Notes, references and maintenance records keep their own entity IDs (#171).
- A device whose first sync finds a key rotation pending (someone was removed
  or a device revoked before it finished joining) now syncs instead of
  failing with "Kin has not initialized encrypted sync."; history it had
  before joining is sealed under the new key, never the retired one (#203).

### Security and access

- Approving a member recovery re-checks admin authority (#154).
- Pairing-code guesses are limited per real client, also behind a trusted
  reverse proxy (`KIN_TRUSTED_PROXIES`) (#155).
- Only the uploader or an Adult can delete an attachment, and only Adults see
  the remove control (#156).
- Creating households is rate-limited, and operators can cap or close it
  (`KIN_MAX_HOUSEHOLDS`, `KIN_ALLOW_NEW_HOUSEHOLDS`) (#157).
- A passkey's sign counter can never go backwards (#158).
- A malformed static path returns 404, not 500 (#159).
- Opened attachment URLs are revoked when Kin locks (#161).
- Calendar export strips control characters (#162).
- Kin pages can't be framed by other sites.

### Recovery and backups

- Recovery keys have short labels (`K-7F3A`). Exports are named for the key
  that opens them, and restore says which key it needs before asking for one
  (#160).

### Reliability and polish

- Drafts survive sync refreshes (appearance, Areas, maintenance records), and
  reminders are kept until their changes commit.
- Overlapping playbook commands are guarded; a checklist that was only
  partly created says so; responsibility changes refresh correctly.
- Trusted-passkey capacity holds under anonymous bootstrap load; fingerprint
  confirmation gates are kept; control boundaries meet contrast requirements;
  appearance presets use native radios.
- Security-panel and passkey regressions fixed, and the daily workspace
  journeys gained regression coverage.

### Platform and operations

- Node.js 24 (24.16 or later) is required; CI runs 24.22.0 (#183).
- A public test server: Docker with Caddy for HTTPS, or Railway. On Railway
  it refuses to start without a data volume, backs up the database once per
  deployment, and can restore a backup at startup (`deploy/`).
- The Railway startup script clears a database lock left by a container that
  was force-stopped during a redeploy (#204).
- The home page no longer fails when a file in the app folder disappears
  while Kin fingerprints it (#201).
- CI: the intermittent Windows Edge browser-suite failures are fixed, and
  both jobs report readable failures (#164).

### Documentation

- [v1.0 compatibility commitment](docs/V1.0-COMPATIBILITY.md) (#165) and
  [known limitations](docs/THREAT-MODEL.md#known-limitations-at-v10) (#166).
- Checklists for the v1.0 reality check, the acceptance matrix and testers
  (`docs/audits/V1.0_*`), and the
  [review-gate decision sheet](docs/audits/V1.0_REVIEW_GATES.md).

### Included: performance and maintainability refactor (slices 1–10)

Development durable stores that accepted older JSON sync pushes should be
wiped or restored from a fresh export. Non-canonical envelope text is now
rejected; no data migration or event-skipping recovery is provided.

Performance and maintainability work, merged from `kin-refactor-track` (#55).
The slices carry no version of their own; they ship in v1.0.0. Baseline and per-slice measurements: [docs/audits/REFACTOR-BASELINE.md](docs/audits/REFACTOR-BASELINE.md).

#### Slice 1 — Measurement baseline and session plaintext arena

- An unlocked tab keeps the decrypted event history in one contiguous
  in-memory arena (`web/storage/event-arena.js`). Commands and refreshes
  decrypt only rows added after the arena's tail instead of the whole log;
  unlock decrypts once instead of twice. A plaintext store-generation counter
  in `security_state`, bumped by migration, restore and root rotation, forces
  a rebuild after any non-append change. Lock, close and peer-tab lock
  zero-fill the arena.
- Replay requests copy the arena's bytes in one operation, and command
  requests no longer copy the history twice.
- Every `kin_alloc` input is freed on every exit path, with tests.
- Adds a projection-equivalence oracle, protocol-24 golden fixtures (native
  and WASM), arena unit tests, a two-tab arena regression and a stage-level
  `scripts/core-performance.mjs` that builds missing WASM.
- Documents the arena in STORAGE, THREAT-MODEL and PRIVACY, and a
  `RUSTUP_TOOLCHAIN=stable` fallback in DEVELOPMENT (the 1.93.0 pin is unchanged).

#### Slice 2 — Protocol 24 is the only format

- Protocols 1–23, the 19 `encode_state_vN` wrappers, the legacy entity
  encoder, the version-keyed decode branches and the pre-v8 replay entry
  points are deleted. One replay path remains: `state::rebuild(events, as_of,
  civil_date)` with distributed ordering, and `core::project` /
  `encode_projection` each have one path. The number 24 is unchanged, and the
  golden fixtures prove event and projection bytes are byte-identical.
- `protocol.rs` (3,166 lines) is split into `wire.rs`, `request.rs`,
  `event_decode.rs` and `state_encode.rs`, with protocol-24 tests in
  `request_tests.rs`, `event_decode_tests.rs` and `state_encode_tests.rs`.
- Schema-1 `ITEM_ADDED`, archive package format 1 and the v0.5→v0.6
  catch-up-context backfill are removed. Development databases are wiped,
  not migrated.
- The bridge's `decodeState` decodes only protocol 24; new bridge tests cover
  truncation, trailing bytes and invalid header fields on the golden
  projections.
- Identity-binding fields stay: they map placeholder IDs in pre-sync history
  and are part of the current sync flow (IDENTITY.md).
- MIGRATIONS.md, TEST-VECTORS.md and ABI.md now describe a single baseline.

#### Slice 3 — Shared component helpers and the `<kin-app>` split

- `web/components/shared/` adds DOM builders, icons, focus snapshots,
  `defineProps`, `OperationGuard` and the session guard. `<kin-household>`,
  `<kin-security>`, `<kin-item-detail>`, `<kin-today>` and `<kin-routines>`
  use them instead of their own copies.
- `kin-app.js` (3,747 lines) becomes a 183-line element. Its methods moved
  verbatim into 18 controller classes under `web/components/app/` (largest
  322 lines) that share one explicit context; state and DOM references stay
  on the element. Listener wiring is three symmetric tables, and methods
  called from outside the element keep one-line stubs.
- The version check reads the service-worker registration from
  `app/status.js`.

#### Slice 4 — Incremental rendering

- The protocol-24 projection gains a section table after its header: one
  `(revision, byte length)` entry per domain section. The body is regrouped so
  each domain is contiguous. Event encoding and the KINE request are
  unchanged; only the golden `.kins` fixtures were regenerated, each checked
  to be the old projection regrouped plus the table.
- Revisions are per engine instance and advance only when a section's bytes
  differ from the last projection that instance emitted. The comparison is
  exact, against the result buffer the ABI already retains, so it needs no
  hash and no extra memory.
- The bridge decoder moves to `web/wasm/projection-decode.js` with one module
  per section family (`kin-engine.js` 1,729 → 971 lines). The engine reuses
  the decoded sections of the last state it produced whenever their revision
  is unchanged, and re-checks counts and cross-section references on every
  decode.
- Views skip rendering when a setter receives the array they already hold. A
  peer refresh in which only Handoffs changed keeps every Item row.
  `refreshFromEvents` restores focus from one `shared/focus.js` snapshot
  instead of five list-specific captures.
- Adds Rust section and revision tests, decoder reuse tests and a two-tab
  incremental-render regression. ABI.md documents the table and revisions.

#### Slice 5 — `<kin-household>`, `<kin-today>` and `<kin-security>` split

- The three largest remaining components become element shells with part
  classes, following `<kin-app>`'s shape. `kin-household.js` 1,404 → 158
  lines plus six parts in `household/` (largest 368). `kin-security.js`
  679 → 123 plus four parts in `security/` (largest 246). `kin-today.js`
  841 → 262 plus three parts in `today/` (largest 338). The household and
  security splits are pure moves.
- `<kin-bulk-bar>` takes the bulk bar's controls, text and focus handoff out of
  `<kin-today>`. The list keeps the selection and the `kin:bulk-*` commands.
- `<kin-today>`'s setters are generated by `defineProps`, which now skips a
  value identical to the current one and coerces missing lists to one shared
  empty array. `update()` renders at once. Selecting an Item uses `update()`
  so focus can return to the rebuilt row.

#### Slice 6 — The engine holds the history; detail, routines and notes split

- Rust keeps each engine instance's canonical history (`history.rs`). The
  bridge's `HistoryMirror` appends only the records added since the last
  call, truncates for a shorter view, and rolls back `historyWith` extras
  after one replay. New exports: `kin_history_reset`, `kin_history_append`,
  `kin_history_truncate`, `kin_project`, `kin_execute`. The whole-history
  `kin_apply_events` and `kin_execute_command` are removed. Allocations sit in
  a fixed 8-slot table. A refresh after one new event appends 0.01 ms of
  history instead of re-encoding and copying all of it (store refresh at
  10k × 4 KB about −33%).
- `<kin-item-detail>` 481 → 263 lines with `item-detail/sections.js`, and its
  setters move to `defineProps`. `<kin-routines>` 500 → 414 with
  `<kin-playbook-editor>` and `<kin-routine-schedule>`. `<kin-notes>` 471 →
  131 with `notes/notes.js` and `notes/references.js`.
- `defineProps` rejects a field named like its property.

#### Slice 7 — Replay struct, finalize and checkpoint

- The 1,040-line `rebuild_with_context` becomes `rust/src/replay/`. `Replay`
  checks every event and dispatches it to one of five domain reducers, whose
  match arms moved verbatim. `finalize(as_of, civil_date)` derives the only
  time-dependent values (Pulse expiry, Routine occurrence and next start)
  without changing the replay. `state.rs` keeps the types; the summary and
  tests move to `state/`.
- The engine's history keeps a replay checkpoint. A projection after new
  events with later logical times applies only those. Anything else rebuilds,
  so results always equal a whole replay. Commands use the checkpoint for the
  current state and apply their event to a copy, instead of two full replays.
  Projecting after one new event: 3.6 ms instead of 9.7 at 10k events, 30
  instead of 62 at 10k × 4 KB. Store refresh is 28–44% faster.

#### Slice 8 — Reading events in place; one test hook

- `EventView` reads a canonical record in place (header fields, payload
  slice), and the history keeps records as `(offset, length)` spans. A
  projection decodes only the records its checkpoint has not applied. The
  summary reads borrowed extracts and copies text only for the 8 entries it
  keeps. Commands check conflicts against the replay instead of every event
  (`CommandHistory`: `WholeRequest` for tests, `HeldHistory` for the engine).
  The projection buffer is reserved once instead of growing by doubling.
  Projecting after one new event at 10k × 4 KB: about 20 ms (was 30).
- `<kin-app>` loses its 45 script-facing stubs. Controllers call each other
  only through `ctx`. Regression scripts use `app.ctx` as the one documented
  test hook. `<kin-security>` gets its six operations from `shell.js` as
  `security.services` instead of calling methods on the element.

#### Slice 9 — Streaming archives

- Exports are package format 3: the same contents, sealed as segments inside
  the KARC v1 container (the context, one per attachment record, then 256
  events per segment) under one HKDF-derived key per archive, with each
  segment's index and finality authenticated. Package format 2 archives from
  v0.47 still restore. Canonical records are bytes, not base64 text, so an
  archive is about 30% smaller.
- Export reads the history from the session arena instead of decrypting the
  store again, and writes the archive into one buffer of its final size.
  Restore opens segments one at a time into one event arena and protects
  rows 256 events at a time; the single atomic write is unchanged.
- `kin_plan_import` replays the engine's held history (the mirror sends it in
  batches of about 4 MiB) and archive checks decode only the plan's
  attachment bindings.
- Export, check and restore report progress; the security panel shows a
  labelled progress bar.
- At 10,000 events with 4 KB of text: export 0.2 s (was 20 s) with +151 MB of
  private memory (was +955 MB); restore 15 s (was 26 s) with +166–219 MB
  (was +525 MB).

#### Slice 10 — Server hygiene

- `/api/sync/events` carries envelopes as binary (`application/octet-stream`)
  instead of base64url text in JSON; JSON is refused. The envelopes, their
  signatures and the relay's storage and validation are unchanged, and one
  codec (`web/sync/envelope-wire.js`) serves both sides. A 20-event batch is
  27–48% smaller. SYNC.md documents the format.
- Request bodies are refused at their limit while they stream: a declared
  Content-Length over it gets 413 before the body is read, and a chunked
  body is cut off as soon as it passes it (`server/http-body.mjs`).
- `durable-store.mjs` (2,299 lines) and `pairing-service.mjs` (1,901) are split
  into a core and method modules (`durable-store/`, `pairing-service/` by
  flow stage); pure moves, attached with `server/mixins.mjs`.
- Portable membership records are compared field by field instead of by
  `JSON.stringify`.

### Included: desktop workspace UX

Desktop-first UX revision from `feat/kin-workspace-ux` (#42); it had no version of its own and ships in v1.0.0. Presentation, navigation and browser-side composition only: Rust/WASM domain rules, events, storage, sync, authorization and cryptography are unchanged. Contract: [docs/WORKSPACE-UX.md](docs/WORKSPACE-UX.md).

- Navigation: five destinations on every width — Today, Lists (To do · Shopping · Staples), Routines (Routines · Reusable checklists), Updates (Handoffs · Talk), Household (Overview · Notes & reference · Areas & status · People & devices · Privacy & recovery). Legacy `#handoff`, `#more`, `#lists`, `#search` and `#needs` resolve to the new routes; `/pair` without a hash opens People & devices. The resolved route is exposed on `kin-app[data-route]` and in the title; Back/Forward and refresh restore page and segment.
- Desktop shell: persistent left navigation from 720px, a readable content column, header Search, a truthful sync chip ("On this device", "Up to date", "Syncing…", "Sync paused", "Offline — saved here") and Lock. Mobile keeps the bottom bar, now with five equal tracks (it previously declared six).
- Shared item detail: one `<kin-item-detail>` holds checklist, photos/files, planned date, responsibility, Area, reminder, pin, archive and Last changed. It opens beside the list from 1180px, in place of the list with a Back control at 720–1179px, and as a full-height sheet below 720px; the same element is re-homed on resize so drafts survive. Archived or missing records are explained instead of acted on.
- Rows: a restrained complete control, the text (opens details), context (planned date, responsibility, Area, pinned), step progress only when steps exist, a compact attachment strip only when attachments exist, `Add photo` and `Details`. No "0 of 0 steps" or repeated history on rows.
- Today: a practical heading with the local date and a capture that asks what the item is (Task or Shopping item), when it matters (Today, Tomorrow, a date, none) and whether to pin it; it creates ordinary `need`/`shopping` records and sets the planning date explicitly. Today is a read-only composition (`web/today-view.js`): items planned for today keep their identity, undated legacy `today` items stay on Today and are also listed under To do, explicit dates win, unfinished earlier plans sit under a calm "Earlier plans" disclosure, routines show from the Rust occurrence state as Today / This week / This two-week period / This month with pauses in non-Normal modes, waiting handoffs link to Updates, pins stay in Quick access, and completed content is a collapsed section.
- Capture feedback: inline "Saved on this device." / "Saved here. Waiting to sync." / "Couldn't save. Your text is still here." with Try again beside the field; a Today capture that saved the item but not its date says so and the retry resumes against the same record (`web/capture-plan.js`).
- Search: results are controls that open the matching item, checklist step (parent opened with the step focused), handoff, topic, note, reference or maintenance entry by canonical id; matches are highlighted with DOM-built `mark` elements; query, filters and results survive navigating away and Back; unavailable targets are explained.
- Routines: existing routines are the page's content; `Add routine` reveals creation; playbooks appear as "Reusable checklists" with their own segment and editor; the `window.prompt` reminder is replaced by `<kin-reminder>` with labelled date/time inputs, shortcuts, a readable confirmation, validation and the "On this device only" explanation (`web/reminder-time.js`).
- Household: the former More page is split into an overview (mode and Pulse at a glance) and four secondary destinations; the mode copy explains its routine effect.
- Wording: byte-count validation messages replaced with plain language that keeps the real limits; handoff acknowledgement reads "Got it" / "Seen"; Talk explains it holds topics to discuss.
- Correctness found along the way: `web/reminders.js` called the browser's `setTimeout`/`clearTimeout` through the class instance, which throws "Illegal invocation" in browsers, so local reminders could never be scheduled from the UI (Node tests passed because they inject timers); the defaults now wrap the globals. `<kin-attachments>` skipped a cached thumbnail when the tile was still being built, so a re-rendered row with a warm preview cache could stay blank; cached previews now apply during the build. Rows that are rebuilt while the viewer is open (a sync tick or a progress update) return focus to the equivalent control instead of losing it. Capture ids are generated as hex so a partial-save retry can find the record it created.
- Tests: `scripts/workspace-ux-regression.mjs` (in-page journeys plus CDP viewport checks with screenshots), `scripts/workspace-screenshots.mjs`, Node tests for routes, Today composition, reminder time and capture plan; existing suites updated for the new structure.

## v0.47.0 — Household Identity & Shared Appearance

_Not tagged: a development candidate whose changes ship in v1.0.0._

- Activate repository-root GitHub verification for Kin changes and
  `kin-development` pushes. The pinned Windows job runs the complete local and
  Edge browser gates; the project-local workflow remains a synchronized
  reference. No product or persistent contract changes.
- Record the household founder as durable owner for new households while leaving legacy ownership unresolved and fail-closed.
- Add owner-authorized, revision-checked opaque encrypted shared settings with household-scoped reads and deletion cleanup.
- Add household name validation, shared appearance/background editing, preview/reset/cancel, member read-only guidance, authenticated titles, and per-property personal override inheritance.
- Add household admins. The founder is the first admin, and admins can promote or demote other Adults after a fresh passkey assertion (`/api/household/admins/options|finish`). The last usable admin cannot be demoted, removed, or leave. Demotion revokes that admin's pending member invitations.
- Require an admin to invite, approve, or remove members, revoke another member's device, request or cancel household deletion, recover an admin, or change shared settings. Legacy households with no admin keep Adult-level management, and their settings and admin grants stay fail-closed.
- Server schema 8 adds `members.household_admin` and promotes only recorded founder-owners. Load validation rejects admin rows on non-Adult members.
- Household access shows admin badges and admin controls, and labels Limited members as "Children & Limited Members" and Temporary access as "Babysitters, Caregivers & Guests". Settings responses report `admin`/`adminRecorded` instead of `owner`/`ownerRecorded`.
- Add a CLI-only, household-scoped operator purge with exact opaque-ID confirmation, exclusive maintenance/service locking, transactional reuse of the normal deletion purge, retained anti-resurrection tombstones, blind row-count status, and post-purge verification. It does not provide arbitrary SQL or database-wide clearing.

## v0.46.0 — Personal Appearance

_Not tagged: a development candidate whose changes ship in v1.0.0._

Implementation candidate on `feat/kin-personal-appearance`, stacked from the
open workspace PR #42 at `dadd92b`. Adds protected member-bound, device-local
appearance modes, palette seeds, and processed backgrounds without adding a
household event, shared attachment, sync, activity, or export contract.

## v0.41.1 — Mobile Attachment Upload Fix

_Not tagged: a development candidate whose changes ship in v1.0.0._

Correctness patch on `fix/kin-v0.41.1-mobile-attachments`; no tag, release, or production certification. Real-world phone testing showed that photos chosen for an item were silently lost, gave no confirmation, and never appeared as tiles.

- Root cause: each item row owned its own `<input type="file">` behind `Details`, and every state refresh (including the 5-second sync tick) rebuilt the rows. A phone picker takes longer than that, so the file was chosen on a detached input whose `change` event bubbled nowhere; the status node passed with the event was detached the same way, so nothing was ever confirmed.
- Fix: `<kin-app>` owns one hidden file input that is never re-rendered. Item rows show a visible `Add photo` button (also labelled "Add a photo or file to …"); notes, references and maintenance records keep an "Add a photo or file" button. A tap dispatches `kin:pick-attachment`, and the app calls `input.click()` synchronously inside that tap so the native picker opens from the user gesture. The file control no longer appears under `Details`.
- Feedback: a per-record progress store (`web/attachments/attachment-progress.js`) drives a status line under the item that survives re-rendering: "Preparing photo…", "Saving securely…", "<name> is saved on this device" (plus "waiting to sync to your household" when sync is configured), or a specific error. Errors use `role="alert"`, stay until the next attempt, and are mirrored in the app alert.
- Refusals name the reason: unsupported type (with the detected MIME type, so HEIC or text files are explained), empty file, over 4 MB, locked session, another save in progress (the app now waits up to 10 s instead of dropping the file), storage failure, or a protected file that could not be bound to its record. Cancelling the picker creates nothing.
- Attachment rows arriving from a sync pass are merged against the current canonical bindings, so a pass that started before a save cannot drop the new tile, and one that started before a removal cannot resurrect it. Reconciliation now gives an unbound `local` row one pass of grace before deleting it as an orphan, so a sync tick cannot discard a photo mid-capture.
- Capture without a server household identity no longer fails with "Unlock Kin before attaching a file": the file is sealed under the device vault (the existing `localSealed` path) and re-encrypted with the household key by reconciliation once one exists.
- Tile state labels: "Saved on this device", "Saved here, waiting to sync", "Syncing", "Synced", "Not downloaded yet", "Couldn't sync or open" (with Retry). The service worker precaches the new progress module so the offline shell still loads.
- Tests: `scripts/attachment-upload-regression.mjs` (run inside the browser regression) drives the journey on a 390×844 mobile viewport through CDP: a synthesized touch on `Add photo`, the browser's own `Page.fileChooserOpened` for the app input, a list re-render while the picker is open, a real JPEG supplied with `DOM.setFileInputFiles`, feedback phases, stored sealed record and canonical binding, tile and thumbnail, viewer open/close with focus return, navigation, Details toggling, a stale sync refresh, lock/unlock restore, an unsupported file refusal, picker cancel, and isolation from another item. The passkey suite now attaches through the row button and the shared input with a household identity. Node tests cover the progress store, the file-problem messages, failure stage tagging, orphan grace, and the rewritten `<kin-attachments>`.

## v0.41.0 — Mobile Experience & Passkey-First UX

_Not tagged: a development candidate whose changes ship in v1.0.0._

Implementation candidate on `feat/kin-v0.41.0-mobile-experience`; no tag, release, or production certification.

- First run opens with a welcome that explains on-device encryption and the three setup steps, then a "Save your recovery key" step with copy and confirmation. Returning users see "Welcome back" with `Unlock with passkey` as the primary action when a PRF wrapper exists; `Use recovery key` reveals the recovery form. Without a passkey, recovery is shown directly with a hint to turn passkey unlock on.
- Passkey unlock keeps its server-verified PRF contract. Network failures are reported as a connection problem that points to the recovery key; a device without a household credential is told to create or join a household first. Offline, the lock screen explains that recovery is the only unlock.
- Security settings show whether passkey unlock is on, offer `Turn on passkey unlock` / `Add another passkey`, keep per-passkey removal (the recovery wrapper can never be removed), add recovery guidance, group backup/restore, and add an optional inactivity lock (5/15/60 minutes) stored as a plain preference. Lock-on-close is unchanged.
- Today shows a "Get started" card for a protected device without a household (create / join / add this device) and an "Unlock faster next time" prompt once the device holds a household credential but no passkey wrapper.
- The household panel asks "How would you like to get started?" with create, join, and add-device choices, explains device protection versus membership in plain language, names the device when creating, and states that entering a code never creates a second household. Joining still uses the existing pairing, fingerprint comparison, approval, and activation flows.
- The Today capture form defaults to Today and keeps the chosen destination; each list on Lists has its own single-field capture fixed to that list. Confirmations name the destination ("Added to Shopping."). Rust classification values and `kin:add-item` are unchanged.
- Images attached to items, notes, references, and maintenance records render as lazily decoded, bounded thumbnails; tapping opens an in-app viewer with Close and Save. PDFs render as document tiles with kind, size, status, Open and Save. Previews are in-memory object URLs revoked on removal, viewer close, and lock. Attachment rows now carry the validated MIME type; CSP `img-src` adds `blob:`.
- Item rows show the text, a short context line, visible photos, and one primary action. Area, planned date, reminder, responsibility, pin, archive, and the file control sit behind a per-item `Details` disclosure.
- Mobile layout: `viewport-fit=cover` and `interactive-widget=resizes-content`, header top safe-area padding, errors shown as a fixed card above the bottom navigation, full-width security actions on narrow screens.
- Sync pauses, offline notices, and attachment failures use plain language and never claim data was synced or deleted; error codes stay on the state object.
- The virtual-authenticator passkey regression now verifies that a server-accepted assertion with the wrong PRF-derived secret stays locked and preserves the encrypted event bytes.
- The server serves `index.html` with the release plus a 12-hex fingerprint of the served shell files as semver build metadata (`0.41.0+abc123def456`); the service worker accepts build metadata in its registration release, so a changed shell always gets a new cache name and an update prompt instead of a frozen mix of old and new modules. The static file keeps the plain release.
- Database-wide clearing was removed from this candidate because it is unrelated to mobile UX; see [database-clear handoff](docs/maintenance/DATABASE-CLEAR-HANDOFF.md) for separate future review.
- Catch up names the list an item was actually added to ("added to Shopping", "added to Staples") instead of reporting every non-Today item as added to Needs; the copy now shares the compose destination labels. Covered by `web/components/kin-catch-up.test.mjs`.
- Tests: new `scripts/mobile-ux-regression.mjs` (run inside the browser regression), passkey-first lock-screen and attachment viewer checks in the passkey suite, welcome/lock-screen checks in the security UI suite, planning-date and area tests expand Details, a 320px Today layout check, Node tests for the preview cache and the new passkey error paths.

## v0.40.3 — CI & Verification Infrastructure

_Not tagged: a development candidate whose changes ship in v1.0.0._

- Add `npm run verify` as the local release gate for pinned Node/Rust/WASM prerequisites, formatting, warnings-denied Clippy, version consistency, every discovered server/web Node test, Rust tests, release WASM and committed-artifact comparison.
- Add `npm run verify:browser` for the five existing browser regression runners, with an explicit `KIN_BROWSER` executable and failing behavior when it is missing.
- Document the local gate and provide a proposed Kin workflow for later root-level integration approval. No product behavior or persistent contract changes.
- Compare generated WASM with a tracked reference when the repository commits one; this repository ignores its generated browser WASM and the runner never replaces it automatically.

## v0.40.2 — Clock & Archive Correctness

_Not tagged: a development candidate whose changes ship in v1.0.0._

- Revoking the device that committed the latest key rotation no longer strands the remaining devices (B-002). The relay keeps each committed rotation package for a still-trusted recipient until that recipient acknowledges it, including after the package's original expiry, and removes it when the recipient is revoked, removed, expired, or changes its device key. Only packages from the relay's own committed rotation get this exception; ordinary key transfers still expire. Clients still check the recipient binding and the sender's signature against verified device-key history.
- The rotating device is now recorded as holding the epoch it committed (P-001).
- Inviting a member or another device from the household page now shows the invitation code. Previously the server's response omitted the inviting device's key fingerprint, so the client's local-key check failed with "This device's approved key does not match its local key." and no code was displayed (B-004).
- `GET /api/household/lifecycle` answers again instead of always returning 500 (B-001).
- Limited and Temporary devices no longer attempt Adult-only epoch rotation or key provisioning during sync. Previously a 403 from those steps paused their sync before pull and push, so non-Adult members could not participate after any epoch rotation.
- The trusted-device list refreshes after a successful device revocation instead of showing the revoked device as still trusted until the page is reopened.
- Archive membership validation now treats `active`, `removed`, and `expired` as server-authored historical statuses. Export and restore do not derive or rewrite those statuses from the browser clock; expiry metadata remains structurally validated and the snapshot grants no live authority (P-003).
- `PairingService.leaveHousehold` evaluates Temporary participation using the injected service clock. Regression coverage confirms self-leave works before expiry and expired members and stale sessions remain denied (P-004).
- Add `scripts/household-authority-regression.mjs`, a live multi-profile household authority and recovery drill against the real server and relay. It operates the real fingerprint-confirmation controls; its evidence and limits are recorded in `docs/audits/LIVE_HOUSEHOLD_VERIFICATION.md`.
- No archive schema/version, encryption format, package-signature format, or authorization-policy change. KARC v1 and existing package-v1/v2 archives remain supported. Server key-package retention and two pairing responses changed as described above.

## v0.40.1 — Portable Membership Status Fidelity

_Not tagged: a development candidate whose changes ship in v1.0.0._

- Preserve explicitly removed Temporary members separately from naturally expired Temporary members in the authoritative server membership directory, package export, and restore normalization.
- Only normalize active Temporary membership to expired when its absolute expiry has passed; removed remains removed after time passes.
- Add a durable server membership-status field without changing access-control decisions.

## v0.40.0 — Restore & Device Migration UX

_Not tagged: a development candidate whose changes ship in v1.0.0._

- Validate the complete package and show its event/attachment summary before the user confirms restore.
- Stage validated data in memory; reload or cancellation discards incomplete staging, and IndexedDB promotion remains one transaction.
- Permit same-household restore as an idempotent no-op when all package events and attachments already exist with matching content; refuse other non-empty targets without changing their data.
- Keep device trust and server authorization separate from household data; after ordinary approval, encrypted sync catches up and deduplicates canonical history.
- Temporary expiry and removed-member state remain data only and cannot reinstate access.
- Same-household restore does not import missing archive rows into an existing installation. If any package event or attachment is absent from the populated target, restore refuses; use a fresh local installation and ordinary approved-device sync for migration catch-up.

## v0.39.0 — Portable Household Export v2

_Not tagged: a development candidate whose changes ship in v1.0.0._

- Introduce an authenticated package-v2 manifest with Kin/package versions, export time, canonical event count, attachment count and ciphertext-byte count while retaining KARC v1 framing.
- Preserve canonical event history, bounded Adult/Limited/Temporary membership status and absolute expiry metadata, and protected attachment records under the existing complete 160 MiB archive and 50 MiB ciphertext limits.
- Continue to read documented archive-v1 packages; reject unknown versions, invalid manifests, damaged attachments, invalid replay, duplicate events and oversized packages before import.
- Keep credentials, sessions and device authority out of the export. Restored data gains sync only after normal household approval.

## v0.38.4 — PWA & Archive Preflight

_Not tagged: a development candidate whose changes ship in v1.0.0._

- Derive service-worker caches from the current release and stage complete shells before activation.
- Align the finite 160 MiB archive cap with the documented 50 MiB encrypted-attachment household bound.

## v0.38.3 — Trust & Access Hardening

_Not tagged: a development candidate whose changes ship in v1.0.0._

- Require Adult authority to enable sync while preserving authorized Limited/Temporary participation.
- Require target-bound fresh passkey proof for device revocation and preserve a usable last-Adult trust path.

## v0.38.2 — Replay & Logical-Time Hardening

_Not tagged: a development candidate whose changes ship in v1.0.0._

- Stale cross-device Item completion/reopen and Responsibility assignment/clear events racing with archive now converge as terminal no-ops; same-device commands after archive remain rejected.
- Remote malformed or replay-invalid events are quarantined before durable acceptance, the relay cursor advances, and later valid events remain replayable.
- Logical time is bounded to positive JavaScript-safe integers; Rust, browser event encoding, storage, and server acceptance share the ceiling and one-million-step advance bound.
- Added replay, quarantine, relay-bound, deterministic-order, and post-poison write regressions. Existing canonical event formats and legacy valid histories remain unchanged.

## v0.38.1 — Authenticated Member Self-Leave

_Not tagged: a development candidate whose changes ship in v1.0.0._

- Limited and Temporary members can leave their own household membership after fresh passkey authentication, while removal of other members remains Adult-only.
- Self-leave revokes the member's devices and sessions and preserves transactional access-change/key-epoch handling. Last-Adult protection remains enforced.

## v0.38.0 — Modes & Member Context Polish

_Not tagged: a development candidate whose changes ship in v1.0.0._

- Household settings present Adults, Limited Members, and Temporary Access as compact sections. Active Temporary access shows its absolute end time; ended access remains identifiable.
- Adult-only controls stay out of Limited and Temporary views. Removal/revocation actions name the member target; Temporary revocation uses the existing passkey-protected access-change flow.
- Responsibility selectors use active Adult/Limited/Temporary participants and exclude removed or expired members. Historical assignment records remain entity-centric.
- Household Modes continue to affect routine presentation/availability only. UI states that Guest mode does not grant Temporary access; Vacation and Rest do not change authority.
- Handoff remains a shared, multi-device household list without a two-person assumption. Reminders remain explicit and browser-local.
- No presence, activity tracking, read receipts, location, scores, contribution analytics, or behavior-monitoring notifications were added.
- Full release gate: 372 Node tests, 170 Rust tests, Edge browser/accessibility regressions, 32 virtual-authenticator assertions, formatting, lint, WASM build, and version consistency pass. WASM-target test execution is unverified on Windows because the generated test binary is not executable there.

## v0.37.0 — Guest & Caregiver Access

_Not tagged: a development candidate whose changes ship in v1.0.0._

- Adults can invite Temporary Members through the existing pairing flow with a required local date/time expiry held by the server.
- Claimants cannot supply or extend kind/expiry during confirmation; server confirmation uses the invitation record.
- At expiry, the first server request reconciles membership, revokes member devices and sessions, and marks key rotation pending. New sync and key access stay blocked until an Adult rotates household access.
- Adults can revoke Temporary access early through the existing passkey-protected member removal flow.
- Responsibility participant lists filter expired members; settings group active and ended Temporary access and provide a named revoke action.
- Already decrypted plaintext on an offline device cannot be remotely erased. A reconnect after expiry is denied.
- Pairing/expiry, durable identity and sync security regressions pass under Node 24.21.0. The full batch release gate remains in progress.

## v0.36.0 — Limited Household Members

_Not tagged: a development candidate whose changes ship in v1.0.0._

- Adult invitations carry a server-held `adult` or `limited` member kind through the existing pairing, passkey, approval, and single-use confirmation flow.
- Limited Members can participate in ordinary synced household work and Responsibility; trust administration stays Adult-only at the server boundary.
- Bound active membership to 12 total: four Adults and eight Limited Members. Temporary members share the total bound.
- Persist member kind in server identity storage with a schema v5 migration; historical rows migrate to Adult.
- Keep Temporary admissions bounded by a required server-held future expiry. Expiry reconciliation revokes devices and sessions and marks key rotation pending.
- Local content archives remain event-history archives; durable server identity backups preserve member kind and expiry.
- Pairing security (50), durable identity (40), durable store/identity round-trip (8), and sync service security (16) pass under Node 24.21.0. The full v0.36–v0.38 gate is recorded under v0.38.0.

## v0.35.1 — Fresh Passkey Self-Removal

_Not tagged: a development candidate whose changes ship in v1.0.0._

- Self-removal now requires fresh passkey authentication before membership/device revocation and access-change rotation.
- Reuse the existing action-bound adult-removal WebAuthn ceremony; reject session-only leave.
- Preserve transactional membership/device/session revocation, invitation-author revocation,
  last-active-adult protection, legacy two-adult compatibility, and pending epoch rotation.
- Clear session/device cookies and lock local authority only after server success.
- Add server and browser/component regressions for fresh proof, cancellation, invalid
  assertions, revocation, sync denial, and durable failure rollback.

## v0.35.0 — More Adult Members

_Not tagged: a development candidate whose changes ship in v1.0.0._

- Bound households at four active adults using the existing approved pairing ceremony.
- Extend Responsibility assignment controls across active member IDs.
- Preserve current/future epoch access for new adults and document recovery, removal, and legacy behavior.

## v0.34.0 — Responsibility Ownership

_Not tagged: a development candidate whose changes ship in v1.0.0._

- Add canonical Items and Routines responsibility assignments with Take, explicit handoff, and clear actions.
- Resolve concurrent assignments by `(logical time, device ID, event ID)` and clear ownership through canonical events after sync detects removed members.
- Add protocol 23 projection support. No scores, contribution analytics, or workload summaries are included.
- Rust replay, protocol, and real WASM tests pass. Browser interaction and accessibility checks remain unverified.

## v0.33.0 — Attachment UX & Lifecycle

_Not tagged: a development candidate whose changes ship in v1.0.0._

- Add local-first attachment capture, protected offline persistence, retryable authenticated relay sync, remote restore, canonical removal, and client orphan reconciliation.
- Include attachment records in bounded household archive format 2; verify ciphertext digests and local-sealed metadata against canonical parent bindings. Older format 1 archives remain supported.
- Add file controls to Items, Notes, Reference Records, and Maintenance Records using the JPEG/PNG/WebP/PDF 4 MiB limit.
- Native, real-WASM, crypto, and offline lifecycle tests pass. Browser interaction, accessibility, and direct archive migration checks remain unverified.

## v0.32.0 — Encrypted Attachments Foundation

_Not tagged: a development candidate whose changes ship in v1.0.0._

- Add bounded AES-256-GCM attachment encryption with routing and epoch authenticated as additional data; filename, MIME type, size, and parent remain encrypted.
- Add authenticated opaque encrypted attachment relay with digest verification, idempotent upload, 4 MiB file, 64-file and 50 MiB household limits, and durable SQLite storage.
- Attachment upload, retrieval, listing, and deletion require an active synced device with the relevant provisioned key epoch. Household finalization purges stored attachments.
- User-facing attachment capture, offline queueing, and archive portability remain follow-up work.

## v0.31.1 — Concurrent Maintenance Archive Correction

_Not tagged: a development candidate whose changes ship in v1.0.0._

- Preserve a maintenance event created offline concurrently with archiving its Reference Record, independent of deterministic device replay order.
- Continue rejecting new maintenance events authored after a Reference Record was archived.
- Rust replay regression test passes.

## v0.31.0 — Maintenance Records

_Not tagged: a development candidate whose changes ship in v1.0.0._

- Add bounded factual maintenance history to Reference Records, including optional next dates and active Routine links.
- Add protocol 21 save/archive events; old histories remain valid and event export/sync reuse existing encrypted paths.
- Add local maintenance history and capture controls under each Reference Record.
- Native Rust, Node, and real WASM tests pass. Manual browser accessibility and the broad regression gate remain pending.

## v0.30.0 — Home Reference Records

_Not tagged: a development candidate whose changes ship in v1.0.0._

- Add bounded structured household reference cards with optional Area, labeled fields, edit, and archive.
- Add protocol 20 save/archive events and deterministic replay; older protocols reject records rather than discard them.
- Keep records inside the existing encrypted local-first event history. No storage or server schema migration is required.
- Cross-device browser and accessibility release-gate checks remain to be completed.

This file records completed Kin releases. The `v0.0.x` releases are planning and documentation milestones; they do not represent implemented application features. The first implementation milestone remains `v0.1.0`.

## v0.29.0 — PWA & Offline Install Polish

_Not tagged: a development candidate whose changes ship in v1.0.0._

- Complete-shell service-worker staging keeps the prior known-good cache on failure; intentional activation cleans obsolete caches.
- Add calm, user-controlled update-ready messaging and local manifest metadata.
- Browser installation/offline launch validation remains environment-unverified.

## v0.28.0 — Local Reminders

_Not tagged: a development candidate whose changes ship in v1.0.0._

- Add explicit, browser-local reminders for active Items and Routines.
- Request Notification permission only after a reminder action; handle denied and unsupported browsers.
- Cancel an Item reminder when its date changes, it is completed, or it is archived.
- Reminders exist only in the active page session. Browser shutdown, suspension, and unavailable service workers can delay or prevent delivery. No push service or nag loop is used.

## v0.27.0 — Household Playbooks

_Not tagged: a development candidate whose changes ship in v1.0.0._

- Add canonical protocol 19 Playbook templates with ordered checklist entries,
  bounded household counts and lengths, edit/archive, and stable replay.
- Add Playbook authoring and use under Routines. Instantiation creates a normal
  Item with independent Checklist Steps; archived templates are retained.
- Protocols 1–18 preserve their prior behavior and reject Playbook-bearing
  history rather than silently dropping templates.

## v0.26.0 — Pins & Quick Access

_Not tagged: a development candidate whose changes ship in v1.0.0._

- Add stable, ordered Pin and Unpin events with a ten-Pin household limit.
- Add an accessible Quick Access section on Today. The current UI supports
  Item Pins, while the protocol defines stable targets for Items, Notes,
  Routines, and Areas.
- Add protocol 18 event kinds 31–32 and a Pin state projection. Existing
  histories replay with no Pins; no storage, archive, or server migration is
  required. Archived targets are omitted from Quick Access.

## v0.25.0 — Search & Filters

_Not tagged: a development candidate whose changes ship in v1.0.0._

- Add private, in-memory search across unarchived Items, checklist Steps,
  Handoffs, Talks, and Notes. Searches remain on the current device and are not
  saved or synchronized separately.
- Add classification, status, and Area filters for Item and checklist-Step
  results while leaving other matching household text visible.
- Bound displayed results to 100 and report the total match count. No event,
  ABI, protocol, storage, or migration change is required.

## v0.24.0 — Useful Household History

_Not tagged: a development candidate whose changes ship in v1.0.0._

- Show a date-only “Last changed” label for each Item, derived from its latest
  effective Item or checklist-Step event in deterministic replay order.
- Add protocol 17's per-Item timestamp projection extension without adding an
  event kind, storage migration, actor attribution, read receipt, or timeline.

## v0.23.0 — Calendar Interoperability

_Not tagged: a development candidate whose changes ship in v1.0.0._

- Download active Items with planning dates as UTF-8 iCalendar (`.ics`)
  all-day events, sorted by date with stable Item-based UIDs.
- Keep export local and read-only; omit completed/archived and undated Items,
  Routines, household metadata, and reminders. No storage migration is needed.

## v0.22.0 — Lightweight Planning Dates

_Not tagged: a development candidate whose changes ship in v1.0.0._

- Add an optional Gregorian civil planning date to existing Items, with a
  native date control, Today/Tomorrow shortcuts, and an explicit clear action.
- Add schema-1 event kind 30 and replay protocol 16. Dates are fixed values,
  never reminders or values that roll with the local clock.
- Preserve offline, encrypted sync, and archive behavior without a storage
  migration; older replay protocols fail closed on dated histories.

## v0.21.0 — Household Modes

_Not tagged: a development candidate whose changes ship in v1.0.0._

- Add Normal, Vacation, Guests, and Rest as explicit canonical household
  modes; old histories default to Normal.
- Pause routine occurrence actions without changing or hiding routine
  definitions; routine archival remains available.
- Add additive replay protocol 15 and event kind 29; older protocol writers
  fail closed on mode-bearing state. Existing encrypted storage, sync, and
  archive boundaries need no migration.
- Pass 151 Rust tests, 230 server tests, focused real-WASM tests, formatting,
  warnings-denied Clippy, release WASM build, version consistency, and the full
  Edge browser regression.

## v0.20.1 — Fast-track integration and accessibility corrections

- Each checklist step's archive control has its own accessible name.
- Release records document the v0.17.0 tag history and describe Staples retry
  and focus behavior accurately.

## v0.20.0 — Staples & Replenishment

- Add a reusable Staples list using Item classification code 3; “Add to
  Shopping” creates an ordinary Shopping Item while leaving the staple active.
- Add replay protocol 14 as the compatibility gate for Staples; protocols 1–13
  continue to support their existing data and reject Staples-bearing state.
- Reuse canonical Item events, encrypted local persistence, sync, and archive
  import/export without inventory, quantity, or schedule automation.
- Pass 148 Rust tests, 311 Node tests, formatting, warnings-denied Clippy,
  release WASM build, version consistency, and browser/security regressions.

## v0.19.0 — Shared Shopping Lists

- Add Shopping as a third Item classification and a dedicated list, reusing
  canonical Item lifecycle events, encrypted local persistence, and household
  sync without a new entity or storage migration.
- Add protocol 13 as the compatibility gate for Shopping classification;
  protocols 1–12 fail closed on Shopping-bearing history and retain their
  existing layouts for Today/Needs data.
- Add Rust, real-WASM, and browser regressions for Shopping capture, list
  isolation, lifecycle, persistence, and focus restoration.

## v0.18.0 — Richer Routine Scheduling

- Add bounded every-two-weeks routines anchored to their creation civil date
  and monthly routines keyed to calendar-month starts; preserve Daily/Weekly
  keys and canonical schema-1 event bytes.
- Add additive replay protocol 12 to make the new cadence values explicit;
  protocols 1–11 reject histories they cannot represent, while prior
  histories replay unchanged under protocol 12.
- Add accessible cadence choices, accurate current-period wording, and Rust,
  WASM, Node, and browser regressions for leap/month/year boundaries and
  protocol compatibility.
- Pass 144 Rust tests, 309 Node tests, formatting, warnings-denied Clippy,
  release WASM build, version consistency, and three consecutive full Edge
  browser regression runs.

## v0.17.0 — Checklist Steps

- Add ordered, bounded checklist Steps to Items with independent completion,
  terminal Step archival, and parent Item lifecycle gating.
- Extend canonical event and replay protocol 11 additively; keep older result
  layouts and persistent schemas unchanged.
- Add native checklist controls, accessible progress, and Step lifecycle
  validation through Rust/WASM and browser regressions.
- Complete the Windows release gate: 139 Rust tests, 308 Node tests, three
  consecutive full Edge browser regressions, targeted security/storage/passkey
  browser suites, version consistency, formatting, and warnings-denied Clippy.

## v0.16.3 — Notes hardening

_Not tagged: a development candidate whose changes ship in v1.0.0._

- Treat same-logical-time Note archives from different devices as one
  deterministic terminal action; reject later or same-device duplicate
  archives as stale commands.

## v0.16.2 — Notes Resilience & Accessibility

- Preserve unsaved Note form state and action focus across canonical rerenders;
  clear in-memory drafts after save and discard them with the protected UI on lock.
- Add unique explicit field labels and field-specific validation associations;
  report local persistence separately from offline synchronization.
- Preserve deterministic stale-command rejection through canonical transaction
  replay and keep Note content within the existing encrypted event pipeline.

## v0.16.1 — Notes correctness

- Make an equal-logical-time cross-device Note update lose to a concurrent
  terminal archive in either deterministic device ordering.
- Match browser Note title/body preflight checks to Rust Unicode-scalar,
  UTF-8-byte, and control-character constraints without UTF-16 maxlength caps.
- Wait for the requested persisted keyboard state in Handoff/Talk browser
  regressions instead of mistaking an idle pre-action state for completion.
- Cache the Notes component in the service worker's versioned static shell.

## v0.16.0 — Household Notes & Reference Context

- Add stable Note identities and canonical create, update, and terminal archive
  events with plain-text title/body validation and optional existing Area links.
- Project Notes through additive replay protocol 10; pre-Note history projects
  an empty Notes collection without synthetic events or storage migration.
- Add Notes under More with create, view, edit, archive, and safe text display.
- Keep Note content inside canonical encrypted events; do not add server-visible
  Note metadata or a plaintext relay index.

## v0.15.5 — Area form accessibility and release-state reconciliation

- Verified `kin-v0.15.4` is already an ancestor of `kin-development`, both point
  to the same release commit, and the version metadata/content are aligned; no
  history or tag repair was needed.
- Give the Area create and rename inputs distinct IDs, labels, help text, and
  validation errors, with each field describing only its own help and error.
- Add browser regressions for duplicate IDs, the rename label, isolated create
  and rename errors, and preserve shared Unicode/UTF-8 validation coverage.

## v0.15.4 — Area input validation and release documentation cleanup

- Align create and rename input checks with Rust Area-name rules for trimming,
  control characters, Unicode scalar count, and UTF-8 size; show specific
  inline guidance and dispatch only normalized valid names.
- Add browser regressions for the shared create/rename validator across ASCII,
  multi-byte Unicode, whitespace, control characters, and byte limits.
- Clarify that the v0.15.x Household Areas implementation line is complete
  through v0.15.4 while retaining its implementation-candidate status.
- Keep decoded pre-v9 item objects on their historical shape; expose `areaId`
  only for v9 results. Update the legacy ABI test adapter for the v9 request
  header and preserve coverage of the earlier wire layouts.

## v0.15.3 — Area UX polish and release gate

- Keep More → Areas light and direct, with explicit empty state and keyboard create/rename/archive flows.
- Verify post-action focus and live status, long names, archived assignment context, 320px reflow, 200% zoom, dark mode, forced colors, labels, and touch targets.
- Run the full relevant regression gate for Rust, replay/migration, WASM, encrypted sync/offline, archive import, backup/restore, browser/accessibility, continuity, and version consistency.

## v0.15.2 — Offline, sync, and hostile-state hardening

- Prove deterministic two-device convergence for independent Area creation, concurrent rename/assignment, and stale pre-archive assignment in either delivery order.
- Verify retry/duplicate delivery remains idempotent and archived Areas reject new commands while retaining old assignments.
- Exercise an encrypted Area event through the relay; plaintext names remain absent from server-visible envelopes/state and decrypt/replay only on a trusted client.
- Keep Areas under the existing household encryption, device revocation, backup, and restore boundaries; no plaintext relay metadata or server schema is added.

## v0.15.1 — Area correctness and migration

- Verify old pre-Area projections remain valid without synthesized records and reject Area state at older protocol versions.
- Reject malformed Area names and zero Area identities during replay; preserve archive associations and treat assignment to a missing identity as invalid.
- Keep known-name duplicate commands idempotently rejected while replay preserves independently created stable identities instead of merging them.

## v0.15.0 — Areas foundation

- Add stable-ID Areas with Rust-owned create, rename, archive, and Item assignment events.
- Add optional Item Area selection and the Area manager under More; quick capture remains Area-free.
- Keep archived associations, reject new assignment to an archived Area when the client knows its state, and preserve pre-Area histories without synthetic records.
- Introduce replay protocol 9 additively; relay metadata remains opaque and Area names stay inside encrypted event payloads.
- Bound households to 32 lifetime Areas; trim Unicode whitespace and limit names to 48 Unicode scalar values and 96 UTF-8 bytes.

## v0.14.5 — Responsive form and More card-flow corrections

- Keep household and security custom elements in block layout so More cards
  have clear boundaries and do not overlap neighboring content.
- Keep the routine form to one column on narrow screens, including its Add
  button, so the entry field remains comfortably usable.
- Correct the optional visual walkthrough to navigate to each destination
  before capturing desktop and phone screenshots.

## v0.14.4 — UX/UI Correctness and Accessibility

- Keep the persistent sync/security state notice attached across lock/unlock
  view rebuilds, with browser regression for offline and revoked-device states.
- Reconcile wide-screen navigation with UX-D4 using a centered primary column
  and a compact horizontal destination row.
- Announce primary route changes politely and update the document title.

## v0.14.3 — Polish, Prototype Alignment, and Design Feedback Gate

- Consolidated the remaining mobile navigation radius on the shared shape
  token, kept the persistent state notice with the current page content, and
  removed remaining one-off shell styling.
- Added npm ignore rules so a package dry run includes the built WASM runtime
  and excludes local build/data trees.
- Recorded the intentional visual differences and deferred prototype
  capabilities in `docs/V0.14.3-DESIGN-NOTE.md`.

#### Visual correction

- Give Kin a clear forest-green brand header, a contained desktop navigation
  rail, stronger page typography, and a welcoming Today introduction.
- Refine the warm-neutral/green palette, card spacing, and capture surface so
  the visual foundation is visible in the product rather than only in tokens.
- Keep the same destinations, household data, and accessible responsive shell.

## v0.14.2 — State Design, Accessibility, Responsive Behavior

- Added a persistent, live-announced offline notice grounded in the browser's
  connectivity event; it reports local saved state and does not claim remote
  sync succeeded.
- Translate server-confirmed untrusted-device and removed-membership sync
  states into plain language while preserving the local copy explanation.
- Keep connection errors and local storage errors separate from successful
  saved state; leave recovery, deletion, and domain authority unchanged.

## v0.14.1 — Information Architecture and Existing Flow Consolidation

- Brought Handoffs and Talk together under Handoff with distinct, keyboard
  operable tabs. Handoffs retain explicit acknowledge/archive actions; Talk
  remains lightweight and has no read receipts or presence.
- Grouped existing household access and privacy/continuity operations in More;
  no route, domain operation, or security authority was removed.

## v0.14.0 — App Shell and Visual Foundation

- Replaced the single long page with five stable destinations: Today, Lists,
  Routines, Handoff, and More. Today and Lists remain views over existing item
  records; no new domain capability or data model was added.
- Added semantic design tokens, warm light/dark system themes, shared surfaces,
  controls, list rows, navigation, and focused responsive layout.
- Moved household access and privacy/continuity controls into More once
  unlocked, while keeping the actual lock/unlock gate available before
  navigation.
- Preserved existing routines, Handoff, Talk, Pulse, identity, sync, backup,
  restore, recovery, and deletion behaviors.
- Deferred shopping, household areas/modes, notes, maintenance, and other
  prototype-only capabilities.

## v0.13.5 — Cancelled-Deletion Restore Authority Correctness

- Preserve a current active household when restoring a backup captured during
  an older, subsequently cancelled deletion request.
- Keep pending current deletion, finalized tombstone, and predating-backup
  protections unchanged.
- Reconcile recovery release documentation and agent guidance with the completed
  v0.13.x implementation line.

## v0.13.4 — Recovery Capacity and Predating-Backup Correction

- Evaluate trusted-device limits after replacement/member-recovery revocations,
  so legitimate recovery remains available at the 16-device boundary.
- Refuse restore when a surviving active household is absent from the chosen
  backup instead of silently dropping its current authority.
- Add boundary regressions for both recovery modes and fail-closed restore.

## v0.13.3 — Recovery UX, Documentation, and Release Gate

- Added plain-language “Replace this device” and “Authorize recovery” actions
  to the existing trusted-device and household-access views.
- Explain before approval which old credentials/devices stop working, that
  copied information cannot be erased, and that the recovering adult must
  create and activate a fresh passkey.
- Completed recovery, key continuity, stale-backup, disaster, irreversible
  boundary, threat-model, and accessibility documentation.

## v0.13.2 — Rollback, Stale Backup, and Disaster Hardening

- Preserve a surviving target database's current active membership,
  credentials, device revocations, device tokens, epoch/rotation state, and
  pending provisioning authority when restoring older durable data.
- Keep finalized deletion tombstones authoritative and continue refusing
  restore over pending deletion.
- Remove superseded credential rows durably during recovery and checkpoint all
  merged authority before atomically publishing the restored database.
- Prove a stale backup cannot revive the recovered adult's old credential or
  device and cannot clear a required key rotation.

## v0.13.1 — Member-Assisted Recovery Correctness

- Let one active adult authorize a short-lived recovery claim for the other
  active adult without changing the target member identity.
- Require the recovering adult to establish and activate a fresh passkey and
  device; revoke their old credentials, devices, tokens, and sessions.
- Reject self-targeted, unrelated, removed-member, revoked-device, stale, and
  replayed recovery attempts, and record attributable recovery audit events.

## v0.13.0 — Recovery Model and Device Replacement

- Defined the recovery capability matrix and separated identity, device,
  content-key, server-restore, and membership authority.
- Added bounded same-member replacement enrollment that gives the new browser
  fresh device state and atomically revokes the selected lost device.
- Reused recipient-bound epoch provisioning; the service receives no plaintext
  household keys and archives remain local-only recovery.
- Documented the honest unrecoverable boundary when all legitimate authority
  and key copies are gone.

## v0.12.4 — Pending-Deletion Restore Authority Guard

Refuse restore if any household in the existing target is `deletion_pending`,
before opening/copying the backup or replacing the target. The storage error
`restore_blocked_deletion_pending` tells the operator to cancel deletion using
current household authority or allow it to finalize first. This avoids restoring
stale membership, device or credential authority during the grace period;
historical authorization state is not merged. Active targets remain restorable,
and finalized deletion tombstones still override stale backups with old
household rows purged/non-authoritative.

Validation passed: 94 targeted lifecycle, backup/restore, durable-store,
lock/validation and identity/device/session tests; all 295 Node/server/real-WASM
tests; 118 Rust tests; formatting, warnings-denied Clippy, release WASM build;
all four Edge browser/security runners; version and whitespace checks.
Regressions verify pending restore refusal against an older active backup,
removed-adult/revoked-device backup refusal, unchanged DB/WAL/SHM and backup
bytes, lock/temporary-file cleanup, actionable admin errors, current-authority
cancellation, active restore and finalized tombstone authority rejection.
Annotated tag `kin-v0.12.4` identifies this correction for PR #22 review.
No v0.13 work is included.

#### Prior v0.12.3 gate evidence

The Windows x64 release checks passed with Node 22.12, Rust 1.93 and Edge
154: 218 server tests, 74 browser-unit tests and 118 Rust tests, plus formatting,
Clippy, release WASM, version consistency, four browser/security runners and
both isolated PowerShell and POSIX (`run.sh` under Git Bash) launcher smokes.
A WSL-built WASM artifact also passed the browser-unit and core browser
regressions; the WSL HTTP launcher was unavailable because that distribution
has no Node executable. The annotated `kin-v0.12.3` tag marks this review candidate; it is not a
published release. Human review is pending and v0.13 work has not started.
Other operating systems/browsers,
physical authenticators, independent security review and production
certification are not claimed.

## v0.12.3 — Lifecycle UX & Release Gate

Adds explicit deletion consequences, passkey cancellation, accessible terminal
sync status, retention guidance and lifecycle regression coverage. Scripted
release gates passed on Windows. The annotated `kin-v0.12.3` tag identifies
this review candidate; publication remains pending human review.

## v0.12.2 — Stale-Device & Recovery Hardening

Finalizes expired requests after restart and on a bounded maintenance interval.
Rejects stale sessions/devices and stops retrying when sync discovers a pending
or deleted household. Documents local-copy, missing-deletion-ledger and backup
limitations.

## v0.12.1 — Retention, Backup & Authorization Correctness

Adds SQLite schema v2 lifecycle metadata and write guards. Restore requires
explicit lifecycle acknowledgement and merges newer pending/deleted tombstones
from an existing target over older backup data.

## v0.12.0 — Household Deletion Lifecycle

Adds an explicit `active → deletion_pending → deleted` server state machine.
Fresh passkey authorization is required to request deletion; household writes
stop immediately, and either adult can cancel with a fresh passkey during the
30-day grace period. Finalization purges server-held household data and leaves
a minimal tombstone.

## v0.11.7 — October Roadmap & Startup Diagnostics

The implementation candidate with durable semantic validation, October planning
and startup diagnostics is tagged `kin-v0.11.7` for human review. Earlier candidate
tags through `kin-v0.11.6` are preserved.
These are review candidates, not published product releases.

Blend the October plan into the existing README and roadmap while preserving
project setup, milestone history and platform contracts. Target one small minor
line per day from v0.12.x on October 3 through v0.40.x on October 31; retain
v0.41–v0.45 as undated follow-up proposals. Add planning contracts, daily cadence,
product boundaries and handoff guidance without implementing future features.

Report listener startup failures with the attempted host/port, a bounded OS error
code and safe recovery guidance. Release the database process lock after both
asynchronous bind errors and synchronous listener configuration failures.
Launchers wait for `service_ready` before claiming readiness, and PowerShell
propagates a nonzero server exit. Document port conflicts and configuration
overrides without encouraging automatic port switching or database deletion.

Passed all 287 Node/real-WASM tests, including six startup regressions for an
occupied port, denied/unavailable addresses, unknown/malformed error codes and
synchronous configuration failure. Verified database-lock cleanup, valid reopen
and exclusion of private exception details from listener diagnostics.

The Windows PowerShell launcher built release WASM, reached `service_ready` and
served the app, health and readiness endpoints successfully with isolated test
storage. Version metadata, the 29 daily targets, local planning links and
whitespace checks passed. Browser/security and POSIX execution gates were not
rerun for this patch; previous results retain their original release attribution.

The published client remains v0.10.3; server schema v1, canonical events,
WASM/browser storage contracts and archive formats are unchanged. This patch
remains a review candidate; no v0.12 capability or broader certification is claimed.

## v0.11.6 — Release Documentation & Code Clarity

Standardize historical release headings on the newer `vX.Y.Z` notation without
changing their release descriptions or grouping. Update the version checker to
recognize those headings and align current candidate metadata and documentation.
Clarify non-obvious code invariants and ownership with focused comments,
especially at the Rust/WASM boundary and in deterministic replay.

This patch adds no product capability or runtime behavior change. The last
published client version remains v0.10.3; server schema v1, canonical events,
replay protocols, local database/envelope versions and archive formats are
unchanged. Earlier validation evidence remains attached to its original version.

Passed 118 Rust tests and doc-tests, Rust formatting, 55 targeted server tests,
JavaScript syntax checks, version consistency and heading-format checks,
238 local Markdown file-link target checks and whitespace validation.
This was a bounded documentation/comment pass, not a full audit or a rerun of
the browser, cross-platform and security release gates.

## v0.11.5 — Durable Semantic Integrity

Durable startup, readiness, backup and restore now share schema, SQLite and
Kin semantic validation. Cross-check normalized routing/authorization columns
against grant JSON, device JSON and canonical opaque envelopes; reject
impossible membership/device limits, credential ownership, sequence and
epoch/rotation state before readiness. Backup validates both source and copy;
restore validates read-only before replacement. No automatic repair or whole-
database tamper resistance is claimed. Expired grants, retained historical
authority and accepted certificate encodings remain supported. Strict input
identity checks prevent malformed grants/proposals from committing invalid state.

Passed 281 Node/real-WASM tests (207 server, 100 new regressions), 118 Rust tests
on both Windows and WSL, formatting, Clippy, release WASM, the product browser
gate, 313 security-storage assertions, 97 security-UI assertions and 18 virtual
WebAuthn/PRF assertions. npm ci/audit, version checks and PowerShell/POSIX
build/launcher smoke gates passed. POSIX used Windows Node through WSL;
native Linux Node and macOS remain unverified. Server schema v1, sync envelope
v1, client/domain formats and backup format remain unchanged. See
[semantic-integrity evidence and measurements](docs/planning/V0.11.0.md#v0115-semantic-integrity-evidence-2026-10-03).

## v0.11.4 — Pre-Merge Durability & Operations Corrections

Share canonical web-root guards between service startup and admin commands,
including symlinked missing ancestors, and prevent static routes from escaping
the web root. Expected stale-writer conflicts now roll back, return HTTP 409
and permit retry without poisoning the store; fatal storage errors still fail
closed. Lock errors include the exact path and safe manual recovery guidance.

Correct durable cursor encoding so bounded pulls can resume, reject missing,
empty and unsupported restore sources before replacement, and isolate the
passkey regression store from the default service database. Regression coverage
proves admin exclusion, cleanup, verified backups and preserved database/WAL/SHM
state. Schema v1, backup format and client/domain versions are unchanged.

Passed 181 Node tests (107 server), 118 Rust tests, formatting, Clippy, release
WASM, product/security-storage/security-UI/WebAuthn-PRF browser gates, npm audit,
version checks and PowerShell/POSIX launcher smoke tests. The POSIX launcher
used Windows Node through WSL; native Linux Node and macOS remain unverified.
See [the hardening evidence](docs/planning/V0.11.0.md#pr-17-pre-merge-hardening-evidence-2026-10-03).

## v0.11.3 — Privacy & Durable-Service Hardening

Hardens persistent record validation, bounded reads, corruption behavior,
error/log output, process restart behavior and backup/rollback documentation.
Tests cover migration interruption, newer-schema rejection, corrupt relay
data, stale-writer conflicts, backup/restore, lock exclusion and a spawned HTTP
server restart that reauthenticates and recovers accepted ciphertext and
sequence state. On Windows x64/Node 22.12 the full Node suite passed 157 tests
after `npm ci`, including all 83 server tests; the Rust, WASM, browser,
security-storage, security-UI, virtual-authenticator and version-consistency
gates also passed. npm reported zero vulnerabilities but warned that the
`better-sqlite3` install script is not covered by `allowScripts`; the installed
native binding loaded successfully. Linux/macOS and launch-workflow validation,
an independent security audit and production certification are not claimed.
Restoring an old backup can roll back revocation or key epochs.

## v0.11.2 — Operations & Recovery

Adds readiness, graceful shutdown and an exclusive single-process service lock.
Adds `npm run backup` using SQLite's online backup API and `npm run restore`
with source validation, exclusive maintenance locking and offline replacement;
preserves the replaced database and any WAL sidecars.

## v0.11.1 — Transaction & Interruption Correctness

Makes migration transactional and fail-closed on interruption or unsupported
newer schemas. Adds on-disk rollback/corruption checks, transaction boundaries
for cross-service mutations and stale-writer compare-and-commit checks.

## v0.11.0 — Durable Identity & Relay Foundation

Introduces SQLite server schema v1 and durable household identity, membership,
credential, trusted-device, authorization, sync-coordination and opaque relay
state. Event success is reported only after the transaction commits. Bounded
indexed reads and persisted relay/device sequences preserve opaque envelopes,
idempotency and cursor behavior across restarts.

## v0.10.3 — Bounded Storage/Archive Hardening & Architecture Closure

Page protected reads and bound decryption concurrency, remove redundant migration
and restore copies, and preserve exact comparison, full Rust replay and atomic
publication. KARC v1 remains the archive format: raw ciphertext stays in browser
buffers while Rust validates compact framing metadata. Legacy archives and ABI
entry points remain supported. Additional corruption and mid-operation lock
checks exercise fail-closed publication.

Archive restoration is intentionally local-only and grants no sync authority.
The [release record](docs/planning/V0.10.0.md) contains same-harness before/after desktop
measurements, compatibility and the internal architecture/security review. No
independent audit, mobile certification, v0.11 redesign or v1.0 work is claimed.

Passed 118 Rust tests, 150 Node/real-WASM tests on both Windows and Linux,
313 security storage assertions, 97 security UI assertions, 18 virtual-authenticator
assertions, the complete product browser gate and PowerShell/POSIX launch workflows.
Maximum-history sampled renderer memory fell from 2.82 to 1.32 GiB; typical 10k
unlock measured 9% slower. KARC v1 archive sizes and canonical bytes are unchanged.

## v0.10.2 — Local Root Rotation & Recovery Lifecycle

Replace recovery protection with an independent random root and a new, re-entered
256-bit recovery key. Durable staging verifies every protected record, canonical
replay and restored sync key before publication. Interrupted replacement resumes
the same candidate; monotonic root versions and lock epochs reject stale tabs.
Existing PRF unlock wrappers are retired and must be re-added with authentication.
Old copied recovery wrappers cannot decrypt newly protected data; rotation cannot
erase previously copied plaintext, keys or backups.

Event/key database schemas remain 3/4. Rotated roots use manifest/local-envelope
v2 with authenticated root versions; original v1 remains readable. Canonical
events, replay protocols, sync-envelope v1 and KARC v1 remain compatible. See
[the release record](docs/planning/V0.10.0.md) and [rotation contract](docs/ROOT-ROTATION.md).

## v0.10.1 — Security Lifecycle & Sync Recovery Correctness

- Keep cancelled security operations from changing a newer unlock's status, controls or busy state. Late completion cannot label an unlocked household as locked or remove its lock control.
- Verify a stable copy of a trusted device's public keys before opening its pinning transaction. Slow fingerprint hashing no longer lets IndexedDB commit before the pin is saved; conflicting pins still fail atomically.
- Recover interrupted key rotations when recipient packages expire or recipient keys change, retaining the proposed epoch key and reconciling accepted proposals after lost responses. Protect pending-rotation updates against stale tabs.
- Advance the static shell cache so offline clients receive the fixes. Canonical events, ABI protocols, encrypted envelopes, archive framing and database versions remain unchanged. No new product capability or dependency.

Passed 117 Rust and 140 Node/WASM/server tests, formatting, Clippy, release WASM build, version consistency, the complete product browser suite, 78 security UI assertions, 18 virtual-authenticator assertions, and encrypted storage/migration/pinning checks including 12 new rotation-storage assertions. Validation and remaining readiness work are recorded in [V0.10.0](docs/planning/V0.10.0.md). Published as annotated tag `kin-v0.10.1` at `e65db23`; the release branch is pushed for PR review into `kin-development`. Merging remains separate.

## v0.10.0 — Portable Core + Local Data Security

Implemented and validated on the v0.10 development branch; the missing annotated tag `kin-v0.10.0` was restored at `2dc94f8` and pushed at the user's request. Startup now requires recovery or verified PRF unlock before loading protected history. A random local root encrypts complete event/context/outbox values and private sync material; independent credential wrappers avoid corpus re-encryption. Revision checks and a durable lock epoch prevent stale-tab wrapper resurrection and protected writes after lock. Drafts are memory-only.

Post-gate lifecycle review fixed a focus/visibility race in the brief interval between attaching an unlocked vault and binding its durable store epoch. Wake checks now wait for the encrypted store, epoch-bearing peer notifications distinguish a newer revocation from a delayed notification delivered after a valid re-unlock, and lock aborts in-flight PRF WebAuthn/server requests.

Migration preserves legacy data until exact-byte decryption and full Rust replay verify the replacement. Nonextractable legacy transport keys authorize encrypted successor keys through a signed, idempotent transition; original canonical events and relay envelopes retain their identity. Rust now owns all 17 household command encoders, command validation, canonical metadata extraction, bounded archive framing and import planning through the existing dependency-free manual ABI.

Encrypted archives restore into an empty installation with fresh local author identity; restored history stays local and does not recreate device trust. The service worker caches static shell assets only and supports offline recovery unlock. Event DB schema is 3, key DB schema 4, local envelope/archive/successor format 1; canonical protocols v1–v8 and sync envelope v1 remain compatible. See [V0.10.0](docs/planning/V0.10.0.md) for actual validation counts, measurements, limitations and v0.11 handoff. The memory-only identity/relay service, lack of in-place local-root rotation, maximum-history latency and broader platform/security review remain explicit limitations.

## v0.9.3 — Recovery, Privacy, and Feedback Readiness

Completed the v0.9 recovery, metadata, logging, corruption, storage-bound, and UX audit. Added same-member trusted-device pairing, fingerprint-confirmed approval, exact-envelope retry after relay cursor reset, and explicit process-local acknowledgement semantics. An exact identity-binding retry remains idempotent at the 256-record capacity boundary; conflicting or new bindings remain rejected, and rejected batches do not partially commit. Canonical IndexedDB event bytes remain authoritative. The identity service and relay remain memory-only; there is no all-device recovery, durable remote history, independent security audit, or cross-browser certification. Ready for product feedback only after the complete release gates pass.

Final pre-merge correction: fixed provisioned epoch-key fingerprint calculation before raw-key zeroization, added cross-device fingerprint and conflicting-key regression coverage, and removed duplicate trusted-device pinning helpers.

## v0.9.2 — Offline Reconciliation and Conflict Semantics

Added the separate transport cursor/high-water, atomic remote canonical-event/replay/cursor commit, local device sequence and Lamport advancement, additive Rust v8 identity-binding interpretation, deterministic equal-time reducer order, and persistent exact-envelope outbox. Archive wins over an equal-time concurrent mutation from another device; accepted bytes remain stored and a later causally invalid mutation pauses replay. Catch-up remains arrival-ordered and independent of transport progress.

## v0.9.1 — Device Provisioning, Epochs, and Revocation

Added recipient-bound ECDH/HKDF/AES-GCM key provisioning, device-key fingerprint comparison, separate member/device/household keys, one-use grant handling, compare-and-advance epoch rotation, member/device revocation hooks, and historical-key entitlement rules. Same-member additional-device enrollment uses the existing pairing code/passkey approval flow. Revocation prevents future access but cannot erase prior keys or plaintext.

## v0.9.0 — Encrypted Event Sync

Added the v0.9 threat/key-lifecycle contract, versioned AES-GCM and ECDSA event envelopes, authenticated opaque push/pull relay, bounded process-local cursors, additive IndexedDB schema 2, and offline multi-device fixtures. Sync encrypts exact canonical Kin event bytes; the service receives no plaintext event semantics or content key. Relay state is in-memory and acknowledgements are not durable.

## v0.8.8 — Active-Member Slot Correctness

Count active memberships rather than retained historical member records when enforcing household capacity. After an adult leaves or is removed, the remaining adult can pair a replacement while the inactive historical membership remains stored. Invitation creation and final approval both enforce the two-active-adult limit, and a full-household approval fails before creating any member, device, credential, session, or confirmed pairing state.

## v0.8.7 — Pairing Security and State Hygiene

Bind pairing approval assertions to the authenticated adult's credential, eagerly remove every session for a revoked device, lazily prune expired sessions and terminal pairing capabilities, and normalize malformed WebAuthn/CBOR/COSE input into controlled verification failures. Clarify realistic signature-counter semantics and retain fresh-session behavior without adding product scope.

## v0.8.6 — Pairing Feedback-Gate Corrections

Use rejection sampling for valid, uniformly selected pairing-code characters; validate invitations before WebAuthn; and give claimed requests a separate 15-minute approval window. Add trusted-device-bound passkey reauthentication, action-bound fresh authentication for adult removal, terminal-claim recovery, early invitation-URL cleanup, HTTPS-aware Secure cookies, and bounded/pruned transient security state. No sync or new household scope is added.

## v0.8.5 — Auth Panel Text Contrast

Set the household authentication panel's text to the app's dark ink color so headings, form labels, explanatory text, and status messages remain readable against its light background. Button-specific and alert colors are unchanged. No authentication behavior or product capability changed.

## v0.8.4 — Pairing Creation Response Correctness

Return the initial `Pending` state from pairing creation so the initiating-adult UI can render a newly created code without dereferencing an absent state. Add an exact response-contract regression and defensive UI fallback for malformed or incomplete pairing status responses.

## v0.8.3 — Household Pairing Pre-Feedback Stabilization

Polish the two-adult journey with URL prefill, clipboard/native sharing fallbacks, readable selectable codes, quiet countdowns, semantic status/error regions, keyboard-native controls, forced-color styling, destructive-action explanations, and actionable passkey errors. Hide local household content on `/pair` before authorization, recover safely from stale claim cookies, reconcile security/recovery documentation, and retain the complete v0.7.x regression suite.

## v0.8.2 — Trusted Devices, Authorization, and Security UX

Make device trust inspectable and revocable, add logout with session-only semantics, define leaving and other-adult removal, revoke all target sessions/devices on membership removal, and prohibit the last active adult from leaving without a supported deletion/recovery path. Add an authorization matrix and actionable passkey, expiry, revocation, trust, and recovery messages without exposing household details before approval.

## v0.8.1 — Pairing Hardening and Failure Recovery

Separate membership approval from joining-device activation: after atomic approval, the joining adult must prove continued possession of the enrolled passkey before receiving a session. Lost-passkey, response-loss, duplicate approval, revoke/approve, server-time expiry, simultaneous invitation, replay, logout, and device-revocation paths fail closed or retry idempotently. Logout invalidates a session without conflating it with device trust.

## v0.8.0 — Household Pairing Foundation

Add the first two-adult household identity model, passkey registration and approval, a ten-minute single-use human-readable pairing code, `/pair` manual entry and invitation links, explicit Pending/Claimed/Confirmed/Expired/Revoked states, server-side attempt/rate limits, atomic membership confirmation, trusted-device inspection/revocation, privacy-safe audit events, and lifecycle tests. The same-origin service stores only a keyed code verifier and never logs codes. Existing local event protocol v1–v7 and IndexedDB schema 1 remain unchanged.

## v0.7.4 — Routine Stale-Action Correctness

Reject routine completion unless the latest occurrence is open, and reject reopen unless it is completed, even when the submitted period key remains current. Preserve existence, archive and period-key preflight checks and the existing stale-state error code. Add two-tab persistence regressions for stale completion and reopen. Harden the manual Wasm ABI so `kin_apply_events` accepts only the exact tracked allocation returned by `kin_alloc`, with expanded ownership regressions. Refresh pairing-planning status through the v0.8.0 checkpoint and update current release metadata. Protocol layouts, persisted event bytes and product capability remain unchanged.

## v0.7.3 — Routine Hardening & Polish

No capability added. Completed the v0.7.x ABI and parser boundary audit, maximum replay and Wasm memory-growth checks, protocol and allocation ownership review, local-only privacy review, and documentation reconciliation. The full hardening gate passed without changing protocol v7, IndexedDB schema 1, or earlier event bytes. See [V0.7.0](docs/planning/V0.7.0.md).

## v0.7.2 — Routine Resilience & Accessibility

No capability added. Validated suspended-tab, midnight, focus and visibility reprojection; stale-tab convergence; failed-write rollback and retry; keyboard focus restoration; semantic routine controls; narrow reflow, forced colors, text spacing and reduced motion. The full Rust, bridge, launcher and Chrome gates passed. See [V0.7.0](docs/planning/V0.7.0.md).

## v0.7.1 — Routine Correctness

No capability added. Audited mixed legacy/Routine replay, civil-date context validation, duplicate/conflicting IDs, logical ordering over wall-clock timestamps, cursor boundaries, historical compatibility and v7 malformed input. Passed 105 Rust tests plus the existing bridge and browser gates. See [V0.7.0](docs/planning/V0.7.0.md).

## v0.7.0 — Routines

Added Daily and Monday-start Weekly Routines with create, complete/reopen current occurrence and terminal archive. Rust owns civil-date validation, deterministic period identity and replay; protocol v7 carries explicit local civil context without changing exports, old protocol bytes or IndexedDB schema 1. Atomic preflight rejects stale period actions instead of retargeting them. Human Routine actions participate in catch-up; timers/focus/visibility only reproject and create no facts. Native controls preserve drafts, keyboard focus and failed-command recovery. No reminders, calendar, assignments, streaks, framework, dependency or backend.

Release validation and remaining platform gaps are recorded in [V0.7.0](docs/planning/V0.7.0.md). The first calendar/contract checkpoint is `f3065fd`; the release includes the end-to-end capability and its regression coverage.

## v0.6.3 — Summary Hardening & Polish

Fixed committed catch-up cursor recovery after a failed snapshot reload in commit `45ca041`: immediately send content-free peer invalidation, preserve the displayed summary, and offer a refresh-only retry without another cursor write. Added two-tab recovery coverage and explicit no-broadcast checks for quota/abort failures; corrected the raw copied-result test to use a v6 summary result. Revalidation passed 82 Rust tests, 31 Node/real-WASM tests, the complete Chrome runner (12 initial scenarios and 21 PASS groups), and the established release checks and PowerShell/WSL HTTP smokes. Moved the misplaced v0.6.2 validation paragraph to its proper section.

Hardening and polish added malformed v6 summary record/count/classification/UTF-8/length/trailing-byte coverage, every truncated v6 summary-result boundary, and a 10,000-event real-WASM v6 summary replay with memory-growth and copied-result lifetime checks. Completed the summary privacy and UI polish audit. Passed 82 Rust and 31 Node/real-WASM tests, fmt, Clippy, release WASM, version check, PowerShell/WSL build-run HTTP smokes and complete Chrome 154.0.8037.95 browser regressions. Firefox, Safari, macOS, native zoom, NVDA and VoiceOver remain unverified; no screen-reader certification is claimed. Full environment details are in [V0.6.0](docs/planning/V0.6.0.md).

## v0.6.2 — Summary Resilience & Accessibility

No new capability. Added catch-up cursor quota/abort rollback and retry, repeated snapshot-read failure recovery, pending cursor-write reconnect, missed view-state notification recovery, both stale/new tab write orders, and Pulse timer refresh while the summary is visible. Extended keyboard, focus, semantic status, reflow, forced-colors, text-spacing and reduced-motion checks. Passed 81 Rust and 29 Node/real-WASM tests, fmt, Clippy, release WASM, version check, PowerShell/WSL build-run HTTP smokes, and complete Chrome 154.0.8037.95 browser regressions. Firefox, Safari, macOS, native zoom, NVDA and VoiceOver remain unverified. Full environment details are in [V0.6.0](docs/planning/V0.6.0.md).

## v0.6.1 — Summary Correctness

No new capability. Added explicit empty/first/middle/latest cursor cases, first-occurrence handling for exact duplicate event IDs, conflicting-ID failure, exact 8/9-entry cap cases, and browser checks for mismatched/partial local cursor metadata. No production behavior change was required. Passed 81 Rust and 29 Node/real-WASM tests, fmt, Clippy, release WASM, version check, PowerShell/WSL build-run HTTP smokes, and complete Chrome 154.0.8037.95 browser regressions on Windows x64 (Rust 1.93.0, Node 22.12.0; WSL2 Ubuntu 22.04.5 POSIX validation). Native zoom, Firefox, Safari, NVDA and VoiceOver remain unverified.

Detailed validation evidence is in [V0.6.0](docs/planning/V0.6.0.md).

## v0.6.0 — Since You Last Looked

Added a Rust-derived, eight-entry catch-up summary for Item, Handoff and Talk changes, with total/omitted counts and an explicit Caught up control. The local cursor is initialized at existing history on first run, stored in the existing `local_context` singleton, and advances transactionally through only the frozen snapshot boundary. Protocol v6 preserves explicit `as_of` and adds a stable event-ID cursor and structured summary result; v1–v5, event codes/bytes and IndexedDB schema 1 remain unchanged. Pulse is excluded from entries but may define the snapshot boundary. No read receipts, member tracking, actor attribution, summary history, analytics, AI, remote service, new household events, migration or dependency.

Passed 78 Rust and 29 Node/real-WASM tests, formatting, Clippy with warnings denied, release WASM build, version consistency, PowerShell and WSL build/run workflows (page and WASM HTTP 200), and the complete Chrome browser regression suite. Windows x64, Rust 1.93.0, Node 22.12.0, Chrome 154.0.8037.95; POSIX build/run via WSL2 Ubuntu 22.04.5. Catch-up keyboard/focus, 48px targets, 320px reflow, forced colors, increased spacing, reduced motion and 200% page-scale emulation passed. Firefox, Safari, macOS, native desktop zoom, NVDA and VoiceOver remain unverified; no screen-reader certification is claimed. Full evidence is in [V0.6.0](docs/planning/V0.6.0.md).

## v0.5.3 — Pulse Hardening & Polish

Added every v5 request/header/envelope/payload and result truncation boundary, 10,000-event mixed replay, memory-growth and copied-result lifetime tests. Made numeric enum identifiers explicit and prefilled Change with the current capacity. Completed time/domain/privacy audit and 320px visual review. No new capability; the authorized Pulse line stops here. Passed 69 Rust and 28 Node/real-WASM tests, the complete Chrome browser suite, fmt/Clippy/version checks, both WASM builds and PowerShell/WSL build-run workflows. Accessibility modes and remaining unverified environments are recorded in [V0.5.0](docs/planning/V0.5.0.md).

## v0.5.2 — Pulse Resilience & Accessibility

Restored capacity-selector focus when expiry hides an active Pulse control. Added late timer, simulated sleep/wake, focus/visibility, clock forward/backward, missed invalidation, original SET/CLEAR quota/abort retry, repeated refresh failures, supersession, rapid intent, reconnect/busy, native keyboard and accessibility-mode coverage. No new capability; evidence is in docs/V0.5.0.md.

## v0.5.1 — Pulse Correctness

Added exhaustive Pulse payload lengths, schemas, reserved/value codes, timestamp bounds, mixed entity invariance, exact v5 layouts, malformed results and combined count limits. Legacy byte fixtures remain unchanged. No new capability or production defect found; validation evidence is in docs/V0.5.0.md.

## v0.5.0 — Pulse

Added fixed actor-scoped capacity, set/replace/clear and explicit expiry. Rust owns rebuild_at(events, as_of); protocol v5 preserves v1–v4 layouts. Native controls and canonical timer/visibility/focus refresh reuse IndexedDB schema 1 and original-command retry. No migration, acknowledgement, analytics, identity inference, automation or dependency.

Validation evidence: [V0.5.0](docs/planning/V0.5.0.md).

## v0.4.3 — Talk Hardening & Polish

Added every truncated v4 result-header/Talk-record boundary, malformed request headers and extreme lengths, 10,000-event mixed replay, and 10,000-Talk real-WASM growth with independent copied results across repeated success/error/empty calls. Retained explicit v3 Handoff truncation/trailing-byte coverage. Visual inspection found and fixed horizontal overflow caused by a 320px page minimum width when a desktop scrollbar consumes space; reflow assertions now compare scrollWidth with clientWidth. The corrected 320px screen preserves full input focus outlines and wrapping actions.

Passed 58 Rust tests and 19 Node bridge/real-WASM tests, formatting, Clippy with warnings denied, version consistency, release WASM, PowerShell and WSL POSIX build scripts and build/run launchers (page and WASM HTTP 200), and complete browser regressions. Environment: Windows x64, Rust 1.93.0, Node 22.12.0, Chrome 154.0.8037.59; POSIX via WSL. Keyboard, all Talk lifecycle focus restoration, native focus order, semantics, busy/status/error, 48px targets, scrollbar-aware 320px reflow, forced colors, increased spacing, reduced motion and 200% page-scale emulation passed. Native desktop zoom, Firefox, Safari, NVDA and VoiceOver remain unverified.

Architecture/product/privacy audit confirms Rust-only reduction; separate Item/Handoff/Talk semantics; immutable canonical IndexedDB schema-1 events; no migration; unchanged v1/v2/v3 contracts and explicit v4; content-free invalidation; textContent rendering; same-origin static requests; no framework/runtime dependency, analytics, AI, remote service, sentiment, scores, blame, identity inference, resolver attribution or response metrics. Resolved is workflow state only and claims neither agreement nor an objective solution. No remaining release-blocking defect was found in exercised environments. Cross-browser, assistive-technology and native-zoom checks remain validation gaps, not certifications. No additional UI feature was added. Duplication remains manageable, so no orchestration refactor was introduced.

## v0.4.2 — Talk Resilience & Accessibility

Expanded Talk browser checks for keyboard resolve/reopen/archive, native input-to-Add focus order, semantic headings/lists, labels, polite status/assertive errors, visible focus and 48px targets under forced colors. Added independent draft assertions and direct stale retries with missed invalidation, alongside repeated-refresh recovery. Retained delayed saves, reconnect, queued peer refresh, sessionStorage denial, quota/abort rollback, rapid retry once and supersession. No production defect was found. Passed 56 Rust and 17 Node/real-WASM tests, formatting, Clippy, version consistency, release WASM, both build scripts/launchers (page/WASM HTTP 200), and complete browser suite in Windows x64/Chrome 154.0.8037.59/Node 22.12.0, POSIX via WSL. 320px, increased spacing, forced colors, reduced motion and 200% page-scale emulation pass; native zoom, Firefox, Safari, NVDA and VoiceOver remain unverified. No new product capability.

## v0.4.1 — Talk Correctness

Talk correctness audit passes the full lifecycle matrix, every truncated payload, overlong references, unsupported schemas, empty/oversized/invalid UTF-8 and blank text, exact v4 records, malformed status/reserved/count/length fields and combined entity limits. Exact pre-Talk writer/result fixtures remain unchanged. Browser tests verify event/counter rollback, retry once, metadata preservation and invalid-transition non-append. No production defect was found. Passed 56 Rust and 17 Node/real-WASM tests, formatting, Clippy, version consistency, release WASM, both build scripts and both launchers (page/WASM HTTP 200), and the complete Chrome 154.0.8037.59 browser suite on Windows x64/Node 22.12.0; POSIX via WSL. Previously listed platform/assistive-technology gaps remain. No new product capability.

## v0.4.0 — Talk

- Added one-field topic capture, Open/Resolved lists, resolve, reopen and terminal archive. Resolution is workflow state only; no agreement, blame or verified-person claim is made.
- Added distinct Rust Talk types and schema-1 event codes 8–11, with explicit protocol v4. Protocols 1–3 and prior event bytes remain unchanged; older protocols reject Talk. IndexedDB stays schema 1 with no migration.
- Reused atomic storage, independent drafts, original-command retry, suspended-refresh recovery, content-free peer invalidation and safe rendering. No runtime dependency or remote service.

Validation evidence is recorded in [V0.4.0](docs/planning/V0.4.0.md).

## v0.3.5 — Build & Run Convenience

### Improved

- Added project-local PowerShell and POSIX shell workflows that reuse the established WASM build scripts, then serve `projects/kin/web` on loopback port 8000.
- Updated the README and development instructions to use the one-command workflow.
- Preserved the existing build boundary, dependency policy, and stale-artifact failure behavior.

### Validation

- Passed `cargo fmt --check`, Clippy with warnings denied, 51 Rust tests, release WASM build, both existing build scripts, both new launchers, 13 Node bridge/real-WASM tests, version consistency, and the complete browser regression runner.
- Windows x64 used PowerShell 5.1, Rust 1.93.0, Python 3.13.14, Node 22.12.0, and headless Edge 154.0.4258.48. POSIX validation used WSL Ubuntu 22.04.5, Rust 1.93.0, and Python 3.10.12. Each launcher served the page and WASM asset successfully with HTTP 200.
- No product capability, event format, protocol, IndexedDB schema, or runtime dependency changed.

## v0.3.4 — Handoff Retry Recovery

### Fixed

- A failed canonical refresh could replace and lose an earlier failed save/action retry. Preserve the original command, intent and feedback through repeated refresh failures; restore it only after successful canonical replay. Recovery does not automatically append anything.
- Stale actions still clear against Rust-derived state. A newly submitted command supersedes the suspended retry. The shared fix also preserves Item retries and keeps newer capture drafts intact.
- Added a browser regression that failed before the fix, plus repeated-failure, add/action recovery, stale cross-tab acknowledgement/archive, Item retry and superseding-command coverage.

### Validation

- Passed 51 Rust tests, 13 Node bridge/real-WASM tests, formatting, Clippy with warnings denied, release WASM build, both build scripts, version consistency and the full browser runner.
- Tested with Windows x64, Node 22.12.0, headless Chrome 154.0.8037.59; POSIX build ran in WSL Ubuntu 22.04. Existing 320px/accessibility-mode, storage, protocol, CSP and same-origin regressions remain passing. Firefox, Safari, native desktop zoom, NVDA and VoiceOver remain unverified.
- No new product capability, persisted event change, IndexedDB migration, protocol change, or dependency. Earlier release tags remain unchanged.

## v0.3.3 — Handoff Hardening & Polish

- Added deterministic Handoff header/extreme-length checks, 10,000-event mixed replay, every truncated result boundary, trailing result rejection, and real WASM memory growth with repeated success/error/empty replay.
- Reconciled current product, protocol, storage, component, accessibility, roadmap and release documentation. Confirmed Rust remains the sole reducer, IndexedDB schema 1 is canonical, history is immutable, peer messages carry no content, and no runtime dependencies, remote services, identity claims or timing analytics were introduced.
- Passed 51 Rust tests, 13 Node bridge/real-WASM tests, formatting, Clippy, release WASM compilation, both build scripts, version consistency and the full browser suite (Windows x64, Node 22.12.0, headless Chrome 154.0.8037.59; POSIX build in WSL Ubuntu 22.04).
- Native desktop 200% zoom, Firefox, Safari, NVDA and VoiceOver remain untested. The planned Handoff line stops here for user evaluation; v0.3.4 and v0.4.0 have not begun.

## v0.3.2 — Handoff Resilience & Accessibility

- Extended browser regression coverage for Handoff delayed saves, reconnect and queued peer refresh, newer draft ownership, sessionStorage denial, acknowledgement/archive write failures, abort rollback, and rapid retry exactly once.
- Verified stale acknowledgement/archive recovery even with missed invalidation, peer-action focus restoration, labeled input, semantic headings/lists, polite status, assertive errors, all busy controls, 48px targets, 320px reflow, forced colors, text spacing, reduced motion and 200% page-scale emulation. No product capability or domain rule changed.
- Passed 49 Rust tests, 11 Node bridge/real-WASM tests, formatting, Clippy, release WASM compilation, both build scripts, version consistency and full browser regressions (Windows x64, Node 22.12.0, headless Chrome 154.0.8037.59; POSIX build in WSL Ubuntu 22.04). Native desktop zoom, Firefox, Safari, NVDA and VoiceOver remain untested.

## v0.3.1 — Handoff Correctness

- Added exhaustive Handoff payload truncation, exact reference lengths, schema rejection, extreme lengths, invalid Unicode, actor provenance, separate ID namespace, and exact result-layout regressions.
- Added malformed result-field recovery and Handoff-specific event/counter rollback, exactly-once retry, metadata mismatch and canonical-byte preservation tests. No new capability or contract change.
- Passed 49 Rust tests, 11 Node bridge/real-WASM tests, formatting, Clippy, release WASM build, both build scripts, version check, and the full browser regression runner (Windows x64, Node 22.12.0, headless Chrome 154.0.8037.59; POSIX build in WSL Ubuntu 22.04). Native desktop zoom, Firefox, Safari, NVDA and VoiceOver remain unverified.

## v0.3.0 — Handoff

### Added

- Dedicated short Handoff capture and needs-attention/recent lists, neutral acknowledgement, and terminal archival. Actor placeholders are not verified people; no named receipt or creator/acknowledger inequality is inferred.
- Rust-owned Handoff types, lifecycle, mixed replay and explicit protocol v3. Protocols v1/v2 remain unchanged and reject Handoff history/state. Existing event bytes and IndexedDB schema 1 remain unchanged.
- Independent tab draft ownership, atomic persistence/retry, content-free peer invalidation, inert text rendering, keyboard/focus/busy behavior. No framework, runtime dependency, or remote service.

### Validation

- Passed 46 Rust tests and 9 Node bridge/real-WASM tests, formatting, Clippy with warnings denied, release WASM compilation, both build scripts and version consistency.
- Full browser regression suite passed on Windows x64, Node 22.12.0, headless Chrome 154.0.8037.59, including prior Today/Needs checks and Handoff lifecycle, mixed replay/reload, invalid-reference non-append, retries/drafts, cross-tab stale acknowledgement, keyboard/focus, 320px, forced colors, text spacing, reduced motion, page-scale emulation, CSP and same-origin requests. POSIX build ran in WSL Ubuntu 22.04.
- Native desktop zoom, Firefox, Safari, NVDA and VoiceOver remain untested. Page-scale emulation is not native desktop 200% zoom.

## v0.2.4 — Today + Needs Compatibility Fixes

### Fixed

- Protocol-v1 `KINS` responses now carry the requested v1 header, matching the unchanged active/completed record layout and zero reserved bytes. Protocol-v2 responses retain their v2 classification/status layout.
- Item busy state now disables every action control, including Archive beside Complete or Reopen. Compose and retry controls remain disabled until the pending operation finishes, with focus restoration preserved.
- Added exact-byte real-WASM ABI regressions for both versions, unsupported v1 state, repeated result/error buffer clearing, bridge decoding, and browser coverage for all busy controls and recovery. The focused adjacent audit found no further defect requiring a production change.

### Validation

- Passed 44 Rust tests, 8 Node bridge/real-WASM tests, `cargo fmt --check`, Clippy with warnings denied, version consistency, release `wasm32-unknown-unknown` compilation, and both PowerShell and POSIX WASM build scripts. POSIX validation ran in WSL Ubuntu 22.04 with Rust 1.93.0.
- The Windows x64 browser runner passed in headless Chrome 154.0.8037.59 with Node 22.12.0: legacy replay, Today/Needs, complete/reopen/archive, pending busy controls, retries, draft ownership, cross-tab canonical refresh, malformed-storage preservation, 320px reflow, CSP/console, and same-origin requests. Existing forced-colors, reduced-motion, text-spacing, and 200% page-scale checks also passed.
- Native desktop 200% zoom, Firefox, Safari, NVDA, and VoiceOver were not tested. No product capability, persisted event change, IndexedDB schema change, or runtime dependency was introduced. Published `kin-v0.2.0`–`kin-v0.2.3` tags remain unchanged.

## v0.2.3 — Today + Needs Hardening & Polish

### Hardened

- Rechecked Rust-owned replay, protocol/event version boundaries, IndexedDB schema 1, immutable history, safe text rendering, same-origin-only runtime requests, content-free BroadcastChannel messages, and the absence of runtime dependencies or remote services.
- Added deterministic 10,000-event classified replay checks through native Rust and real WASM, plus valid/error/empty/repeated-call coverage for stale ABI output handling.
- Completed focused Today/Needs clarity and accessibility regressions without adding a product concept. `v0.3.0 — Handoff` remains future work.

### Validation

- Passed 44 Rust tests, 4 built-in Node bridge tests, `cargo fmt --check`, Clippy with warnings denied, version consistency, and both PowerShell and POSIX WASM release builds. The shell build ran in WSL Ubuntu 22.04 with Rust 1.93.0.
- The Windows x64 browser runner passed in headless Chrome 154.0.8037.59 with Node 22.12.0. It covered v0.1 byte preservation, protocol errors/repeated calls, maximum 10,000-event replay, draft/action recovery, stale cross-tab actions, two-tab canonical replay, 320px, forced colors, reduced motion, increased text spacing, 200% page-scale emulation, CSP, and same-origin-only requests.
- Native desktop 200% browser zoom, Firefox, Safari, NVDA, and VoiceOver were not tested. The 200% check was Chromium page-scale emulation, not native desktop zoom; no screen-reader certification is claimed.
- No product capability, IndexedDB schema change, runtime dependency, framework, backend, or remote service was added.

## v0.2.2 — Today + Needs Resilience & Accessibility

### Improved

- Hardened complete/reopen/archive failures and retries; a domain-invalid retry now reloads canonical events and clears stale item intent instead of repeatedly presenting an unavailable action.
- Restored compose focus when a peer refresh replaces a focused item control and disabled retry controls while the app is busy.
- Extended browser coverage for text-only draft compatibility, action write failures/abort recovery, two-tab stale-action races with and without invalidation delivery, and keyboard lifecycle actions.
- Added forced-colors, reduced-motion, increased-text-spacing, 320px reflow, target-size/focus checks, and 200% Chromium page-scale emulation.

### Validation

- Passed 43 Rust tests, 4 built-in Node bridge tests, `cargo fmt --check`, Clippy with warnings denied, version consistency, and both PowerShell and POSIX WASM release builds. The shell build ran in WSL Ubuntu 22.04 with Rust 1.93.0.
- The Windows x64 browser runner passed in Chrome 154.0.8037.59 with Node 22.12.0. It covered draft restoration/ownership, action failures and retries, stale cross-tab intent with and without invalidation delivery, keyboard/focus recovery, 320px reflow, forced colors, reduced motion, increased text spacing, 200% page-scale emulation, CSP, same-origin requests, and the event/storage compatibility regressions.
- Native desktop 200% browser zoom, Firefox, Safari, NVDA, and VoiceOver were not tested. The 200% check used Chromium page-scale emulation, not native desktop zoom; no screen-reader certification is claimed.
- No product capability, IndexedDB schema change, framework, or runtime dependency was added.

## v0.2.1 — Today + Needs Correctness

### Hardened

- Added exact malformed-length coverage for `ITEM_REOPENED` and `ITEM_ARCHIVED` payloads and a regression ensuring protocol v1 rejects state it cannot represent rather than dropping classification/status.
- Extended browser regressions to verify event and logical-time counter rollback on failed/aborted writes and exactly-once counter advancement on retry.
- Reconciled test vectors, traceability, and the current compatibility contract; no product capability or persistent schema changed.

### Validation

- Passed 43 Rust tests, 4 built-in Node bridge tests, formatting, Clippy with warnings denied, version consistency, and both PowerShell and POSIX WASM release builds.
- The Windows x64 browser runner passed in Chrome 154.0.8037.59 with Node 22.12.0, including exact v0.1 byte preservation, malformed lifecycle payloads, event/counter rollback and retry, metadata mismatch preservation, the 10,000-event cap, cross-tab replay, CSP, same-origin requests, keyboard submission, focus, and 320px reflow. The shell build ran in WSL Ubuntu 22.04 with Rust 1.93.0.
- No product capability, IndexedDB schema change, framework, or runtime dependency was added.

## v0.2.0 — Today + Needs

### Added

- Added separate Today and Needs views, with new items defaulting to Needs and a native classification selector for Today.
- Added completion, reopening, and terminal archival intents. Archived items remain in event history and are hidden from ordinary views.
- Added explicit protocol v2 and schema-v2 `ITEM_ADDED` classification while preserving protocol v1, schema-v1 event bytes, and IndexedDB schema version 1. Legacy unclassified items normalize to Today.
- Extended text draft ownership to the submitted text-and-classification snapshot and added browser regressions for retry, reload, two-tab replay, and lifecycle actions.

### Validation

- Passed 41 Rust tests, 4 built-in Node bridge tests, `cargo fmt --check`, Clippy with warnings denied, version consistency, and both PowerShell and POSIX WASM release builds. Browser regressions passed on Windows x64 with Node 22.12.0 and Chrome 154.0.8037.59; the shell build ran in WSL Ubuntu 22.04 with Rust 1.93.0.
- Browser checks covered Needs-default and Today capture, synthetic v0.1 event replay with exact byte preservation, failed-write retries, text/classification draft ownership, completion in both views, reopen/archive, invalid-transition non-append, hidden tombstones after reload, cross-tab content-free invalidation, malformed-row preservation, keyboard submission, focus, busy state, 320px reflow, CSP, and same-origin requests.
- Forced-colors, 200% zoom, Firefox, Safari, NVDA, and VoiceOver were not tested for this milestone.
- No new IndexedDB schema, framework, runtime dependency, backend, or remote service was added.

## v0.1.5 — Final 0.1.x Stabilization

### Fixed

- Prevented a successful retry of an earlier failed add from clearing a newer compose draft. Draft clearing now belongs to the captured, successfully persisted submission, including delayed normal adds; retry still uses the original command.
- Retained failed-command retry feedback after a successful peer refresh and kept reconnects from restarting the engine or unlocking an in-flight save.
- Aborted synchronous IndexedDB write-request failures with their original storage-error guidance.
- Stopped the PowerShell build script before copying a stale WASM artifact when Cargo fails.

### Tests

- All 32 Rust tests, 3 built-in Node bridge tests, formatting, Clippy with warnings denied, the WASM release build, both build scripts, and version consistency passed. Injected Cargo failures stop both build paths before copying an artifact.
- Added a dependency-free browser regression runner covering normal add/clear, failed add with unchanged or edited draft, synchronous/asynchronous injected quota failures, repeated retry exactly once, commit/abort behavior, and delayed completion across reconnect.
- Browser checks also passed for startup, completion, reload/Rust replay, keyboard submission, draft restoration and sessionStorage denial, successful peer refresh retaining retry, two-tab content-free invalidation and canonical reload, malformed-row preservation, Unicode, inert script-like text, focus restoration/outline, 320px reflow, and busy-state cleanup.

### Validation

- Tested on Windows x64 with Rust 1.93.0, Node 22.12.0, and headless Edge 154.0.4258.48 through local CDP. Shell build validation used Git Bash on Windows. Page requests stayed same-origin; no uncaught errors or CSP violations occurred. The automatic favicon 404 is excluded from console assertions.
- Firefox, Safari, standalone Chrome, native browser zoom, NVDA, and VoiceOver were not tested for this patch. Quota failures were injected; the host disk was not filled.
- No new product capability or dependency was added. This closes planned 0.1.x stabilization; the next development target is v0.2.0.

## v0.1.4

### Fixed

- Preserved the original IndexedDB write failure cause so quota errors receive actionable retry guidance without losing the draft or changing the event log.

### Improved

- Refreshed same-origin peer tabs from the canonical IndexedDB event stream through Rust replay using content-free BroadcastChannel invalidations.
- Added cross-platform build and version-consistency tooling, an explicit WASM-focused Rust toolchain pin, and a same-origin Content Security Policy.
- Expanded malformed protocol, deterministic replay, storage retry, cross-tab, and accessibility regression coverage.

### Tests

- 32 Rust tests and 3 built-in Node bridge tests passed.
- `cargo fmt --check`, Clippy with warnings denied, `wasm32-unknown-unknown` release build, both build scripts, and the version-consistency check passed.
- Browser checks passed for add/complete/reload, keyboard submission, Unicode and inert rendering, malformed-row preservation, quota abort/retry, two-tab refresh, 320px layout, and same-origin requests.

### Validation

- Tested on Windows 10 x64 with Rust 1.93.0, Node 22.12.0, and headless Edge 154.0.4258.48 through local CDP; CSP loaded with no CSP violations. An automatic `/favicon.ico` request returned 404.
- Forced-colors, increased text spacing, and 320px reflow were checked in the integrated VS Code browser (Code 1.139.1, Electron 43.6.0, Chromium 150). Native 200% browser zoom, Firefox, Safari, standalone Chrome, NVDA, and VoiceOver remain unverified.

## v0.1.3

### Audited

- Confirmed JavaScript remains a browser adapter and renderer; Rust remains the only authoritative event validator and item-state reducer.
- Documented the event, identity, ordering, and protocol foundations that later capabilities can extend without implementing those capabilities.
- Confirmed no npm runtime packages, frontend frameworks, WASM helper crates, or third-party network dependencies are present.
- Rechecked local-only storage/requests, privacy-safe diagnostics, and the v0.0.10 community/security/support guidance.

### Validation

- Full Rust, bridge, WASM, reload, malformed-storage, Unicode, keyboard, and narrow-viewport regressions were run for the v0.1.x line.
- The release review records remaining platform and assistive-technology gaps and makes no certification claim for untested environments.

## v0.1.2

### Improved

- Preserved in-progress compose drafts across same-tab reloads with best-effort `sessionStorage`; successful persistence clears the draft.
- Restored keyboard focus after asynchronous add and completion actions and exposed initialization/save progress with `aria-busy`.
- Kept retryable startup feedback for WASM and IndexedDB failures without discarding stored household events.

### Validation

- Verified draft restore/clear, WASM failure and retry with focus restoration, add/complete focus continuity, status updates, reduced-motion preference, and 320px/360px/640px reflow in the browser.
- Confirmed a blocked `sessionStorage` does not prevent startup or saving; draft retention degrades without affecting the event store.
- Confirmed primary controls are at least 48px high. Testing used Windows 10 x64 with the integrated VS Code browser (Code 1.139.1, Electron 43.6.0, Chromium 150.0.7871.250).
- Screen-reader and non-Chromium browser testing remain unverified.

## v0.1.1

### Fixed

- Preserved leading U+FEFF and other Unicode text during UTF-8 validation while continuing to reject malformed lone surrogates.
- Closed IndexedDB connections when local-context initialization fails or a blocked open later completes.
- Rejected corrupted event metadata through deterministic integrity errors before lossy conversion or replay.

### Tests

- Added regression tests for BOM/emoji preservation, malformed surrogate input, and the exact UTF-8 byte limit.
- Verified invalid completion does not append, corrupted rows remain stored, concurrent tabs preserve contiguous event order, and rapid duplicate submission creates one event.
- Re-ran 24 Rust tests, 3 built-in Node bridge tests, formatting, Clippy, the WASM build, and browser reload checks.

## v0.1.0

### Added

- Delivered the local Household Heartbeat flow using native Web Components, Rust/WASM event validation and replay, and IndexedDB event persistence.
- Added and completed household items, with deterministic state reconstruction after reload.
- Added the manual versioned binary ABI, local identity placeholders, bounded protocol parsing, and regression tests for replay and malformed input.
- Added project-local build and static-serving instructions.

### Validation

- Rust unit and protocol tests passed; the `wasm32-unknown-unknown` release build succeeded.
- Browser checks passed for add, complete, reload, inert rendering of script-like text, keyboard submission, narrow layout, and same-origin-only requests.
- Windows 10 x64 was exercised using the integrated VS Code browser (Code 1.139.1, Electron 43.6.0, Chromium 150.0.7871.250). Firefox, Safari, standalone Chrome, and assistive-technology testing were not performed.

## v0.0.12

### Added

- Established a project-scoped changelog and documented how release entries are maintained.

### Changed

- Updated Kin's current release references through `v0.0.12`; `v0.0.9` remains the specification freeze and `v0.1.0` remains the first implementation milestone.

## v0.0.11

### Added

- Defined the general minor-release cadence: capability in `.0`, then correctness, resilience/accessibility, and hardening patches when meaningful work exists.

### Changed

- Corrected stale current-version references and confirmed that `v0.1.0` is the first implementation milestone.

## v0.0.10

### Added

- Added project-scoped Code of Conduct, security, support, contribution, issue-template, and pull-request guidance.
- Documented GitHub's discovery limitations for community files nested in the ZTM Build Fest monorepo.

## v0.0.9

### Added

- Completed the implementation preflight, accepted architecture decisions, canonical test vectors, and requirement traceability for the frozen `v0.1.0` scope.

## v0.0.8

### Added

- Documented contributor expectations, cross-platform development guidance, code style, release process, and privacy-safe debugging.

## v0.0.7

### Added

- Specified persistent-contract versioning, migration safety, portability, retention, and event-log evolution.

## v0.0.6

### Added

- Froze the initial implementation contract for the manual JS/WASM ABI, binary protocol, IndexedDB event store, components, tests, and accessibility.

## v0.0.5

### Added

- Specified household/member/device identity, pairing, cryptographic posture, threat model, and synchronization design.

## v0.0.4

### Added

- Defined the household domain, immutable event semantics, entity lifecycles, and deterministic state reconstruction.

## v0.0.3

### Added

- Documented initial UX flows, the release roadmap, and the first implementation specification.

## v0.0.2

### Added

- Established the technical foundation: architecture, event model, local-first direction, privacy posture, and dependency policy.

## v0.0.1

### Added

- Defined Kin's product foundation, intended users, principles, scope, and non-goals.
