# Self-hosting Kin

How to run the Kin service for your own household, on your own server. Kin
is one Node.js process with one SQLite file; everything a household stores
reaches the service encrypted, so the server never needs to be trusted with
household text. What it does hold (identity, device trust, encrypted
envelopes, and a few things named below) is spelled out in
[PRIVACY](PRIVACY.md) and the [threat model](THREAT-MODEL.md).

If you only want to try Kin, the hosted instance at
<https://kin.journeytocode.io> is the same software, and the README explains
how to [run it on your own computer](../README.md#run-kin-locally).

## Pick a way to run it

| Option | Good for | Guide |
| --- | --- | --- |
| **Docker Compose with Caddy** | A Linux server you control; HTTPS is automatic | [deploy/README.md](../deploy/README.md) |
| **Railway** | No server to look after; a volume and one DNS record | [deploy/railway/README.md](../deploy/railway/README.md) |
| **Node directly, behind your own proxy** | You already run nginx, Caddy or Traefik | This page |

Whichever you choose, decide the public address first. Passkeys are bound to
the domain name, and every device in a household signs in against it.
Changing the address later means every member sets up again.

## Requirements

- **Node.js 24.16.0 or later.** Kin uses Node's built-in `node:sqlite` and has
  no npm dependencies; 24.16.0 is the first release whose SQLite
  binding returns text with embedded NUL bytes intact. CI runs 24.22.0.
- **The WebAssembly engine**, `web/wasm/kin_engine.wasm`. Build it once with
  Rust 1.93.0 and the `wasm32-unknown-unknown` target (`rustup target add
  wasm32-unknown-unknown`, then `./build-wasm.sh` or `./build-wasm.ps1`), or
  let the container image build it for you. Rust is not needed at runtime.
- **HTTPS** for any address other than `localhost`: WebAuthn (passkeys),
  service workers and push all require a secure context. Kin itself speaks
  plain HTTP on loopback and expects a TLS proxy in front of it.
- A little disk. The database is a few megabytes for a household; photos and
  attachments add to it (they are stored encrypted in the same file).

## Run the service

```sh
cd projects/kin
npm ci                               # Kin has no npm dependencies; this only confirms the lockfile
sh build-wasm.sh                     # or ./build-wasm.ps1 on Windows
KIN_ORIGIN=https://kin.example.org \
KIN_DATA_DIR=/var/lib/kin \
KIN_TRUSTED_PROXIES=127.0.0.1,::1 \
node server/start.mjs
```

Wait for the log line `{"event":"service_ready","origin":"https://kin.example.org"}`
before opening the address. `server/start.mjs` is the only supported entry
point: it creates the data directory and starts the service under Node's
permission model, able to read the app and read and write the data directory,
and nothing else ([the service sandbox](DEVELOPMENT.md#the-service-sandbox)).
Running `node server/server.mjs` directly is refused.

A minimal systemd unit:

```ini
[Unit]
Description=Kin household service
After=network-online.target

[Service]
User=kin
WorkingDirectory=/opt/kin/projects/kin
Environment=NODE_ENV=production
Environment=KIN_ORIGIN=https://kin.example.org
Environment=KIN_DATA_DIR=/var/lib/kin
Environment=KIN_TRUSTED_PROXIES=127.0.0.1,::1
ExecStart=/usr/bin/node server/start.mjs
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Keep the data directory outside `web/`, readable only by the service user,
and back it up separately (below).

## Put a TLS proxy in front

Kin listens on loopback only (`KIN_HOST`, default `127.0.0.1`), so a public
deployment needs a proxy that terminates HTTPS and forwards to
`127.0.0.1:8000`. Set `KIN_ORIGIN` to the public `https://` origin; Kin
refuses a public origin that is not HTTPS.

Because every request then arrives from the proxy's address, tell Kin which
addresses are proxies with `KIN_TRUSTED_PROXIES` (a comma-separated list, for
example `127.0.0.1,::1`) and have the proxy **replace** `X-Forwarded-For`
with the client address it saw. Kin uses the right-most `X-Forwarded-For`
address that is not itself a trusted proxy, ignores the header when the
setting is empty or the request comes from any other address, and so can't be
fooled by a client that writes its own header. This matters because the
per-client limits (pairing-code guesses, new households) otherwise treat every
client as one.

nginx:

```nginx
location / {
  proxy_pass http://127.0.0.1:8000;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $remote_addr;
}
```

Caddy (the Compose setup uses this):

```caddyfile
kin.example.org {
  reverse_proxy 127.0.0.1:8000
}
```

An invalid `KIN_TRUSTED_PROXIES` value stops startup with an explanation.
IPv4 clients are limited per address and IPv6 clients per /64 network; only
failed pairing-code attempts count, so a household's own successful pairing
never uses up its limit.

## Settings

All configuration is through environment variables. None are required for a
local trial; a public server needs `KIN_ORIGIN` and, behind a proxy,
`KIN_TRUSTED_PROXIES`.

| Variable | Default | What it does |
| --- | --- | --- |
| `KIN_HOST` | `127.0.0.1` | Address to listen on. Keep it on loopback and let the proxy face the network. |
| `KIN_PORT` | `8000` | Port to listen on. |
| `KIN_ORIGIN` | `http://localhost:<port>` | The public origin members open. Must be `https://` unless it is localhost. Passkeys are bound to it. |
| `KIN_DATA_DIR` | `projects/kin/.kin-data` | Directory for the database and its lock and sidecar files. Created at start. |
| `KIN_DATABASE_PATH` | `<data dir>/kin.sqlite` | The database file itself, if you want a specific path. |
| `KIN_TRUSTED_PROXIES` | empty | Proxy addresses whose `X-Forwarded-For` is believed (above). |
| `KIN_ALLOW_NEW_HOUSEHOLDS` | `true` | `false` refuses every new household, for example once yours exists. Existing households and invitations into them keep working. |
| `KIN_MAX_HOUSEHOLDS` | unlimited | Refuses a new household once this many exist. Deleted households don't count; one waiting out its deletion grace period does. |
| `KIN_PUSH_SUBJECT` | the origin | The contact the push service uses in its VAPID claims. Needed only when the origin is not `https://`; push is unavailable until one of them is. |
| `KIN_ANDROID_PACKAGE`, `KIN_ANDROID_CERT_SHA256` | unset | Serve `/.well-known/assetlinks.json` for a Google Play app (below). Set both or neither. |
| `KIN_FEEDBACK_GITHUB_REPO`, `KIN_FEEDBACK_GITHUB_TOKEN`, `KIN_FEEDBACK_GITHUB_API` | unset | Forward in-app reports to GitHub issues (below). Set the first two together or neither. |

Independently of these, creating a household is limited to 3 per client per
hour, kept in memory (a restart resets it). An invalid value for any setting
stops startup with an explanation rather than running with a guess.

The Compose and Railway setups add their own: `KIN_DOMAIN` (Compose, from
which `KIN_ORIGIN` is derived), and `KIN_BACKUPS_KEEP` and `KIN_RESTORE_FROM`
(Railway's start script; see its guide).

## Health and readiness

- `GET /health` answers while the process is up (liveness).
- `GET /readiness` additionally validates the SQLite structure and Kin's
  identity, routing, sequence and epoch invariants across all households, and
  answers 503 without exposing rows or paths if anything is inconsistent. It
  runs synchronously, so its latency grows with stored history.
- `GET /privacy.html` is the public privacy policy. It names the hosted
  service; an operator should publish their own, kept accurate to
  [PRIVACY](PRIVACY.md) and [RETENTION](RETENTION.md).

The service logs one JSON object per line to standard output
(`service_ready`, `startup_failed`, `request_failed` and so on) and never
household text.

## Back up and restore

The database holds identity and routing metadata, authorization state,
encrypted settings and encrypted event envelopes. It never holds household
plaintext or content keys, but a stale restore can roll back device
revocations or key epochs, so treat backups as sensitive and keep them out of
the web root.

```sh
# While the service runs: an integrity-checked copy (SQLite VACUUM INTO)
npm run backup -- /private/kin-backups/kin-$(date +%F).sqlite

# Only while the service is stopped
npm run restore -- /private/kin-backups/kin-2026-10-22.sqlite --acknowledge-deletion-history
```

Restore validates the file, refuses it if any target household has a pending
deletion or if it predates a household that exists now, merges finalized
deletion tombstones so deleted households stay deleted, and keeps the
replaced database and its WAL sidecars as `kin.sqlite.pre-restore-…`.
[DEVELOPMENT](DEVELOPMENT.md#development-data) explains the lock files
(`<database>.service.lock`, `<database>.maintenance.lock`) and how to tell a
stale lock from a live one before removing it.

Backups contain no decryption keys. Each member's history is recoverable only
with their own recovery key, password or passkey; if a household loses every
unlock path, Kin reports the history as unrecoverable rather than granting
stale authority.

## Updating

Pull the new code, rebuild the engine if `rust/` changed, and restart the
service. Server schema migrations are forward-only, so take a backup first if
rolling back matters; the [release notes](RELEASES.md) say which releases add
schemas. The service worker fingerprints the served files, so members see
"A new Kin version is ready" the next time they open the app.

Every v1.x release keeps reading every v1.0 format
([V1.0-COMPATIBILITY](V1.0-COMPATIBILITY.md)). Data created by v0.x
pre-releases is not supported: start fresh.

## Optional: forward reports to GitHub issues

People can report a problem from inside Kin (anyone, including from the lock
screen), and household admins can suggest a feature. Nothing is sent until
the person presses Send on a preview that shows every detail (each removable)
and where it goes. Reports land in this service (server schema 26, the
`feedback` and `feedback_screenshots` tables): the typed text, the
diagnostics the person kept (version, browser, screen size, route name, sync
state, recent error codes; never household text, names, usernames or IDs),
and a cropped screenshot of at most 1 MiB only if they chose one. Limits: 5
reports and 3 suggestions per member per hour and 20 per address per day;
without signing in, 2 per address per hour and 5 per day. Everything is purged
after 180 days, with the member on removal and with the household on its
deletion.

Read them with the admin command, which is safe while the service runs:

```text
node server/admin.mjs feedback-list [--kind problem|suggestion] [--status received|planned|done|wont-do] [--limit n]
node server/admin.mjs feedback-show <reference> [--screenshot <new-file>]
node server/admin.mjs feedback-set-status <reference> received|planned|done|wont-do
node server/admin.mjs feedback-forward <reference>
node server/admin.mjs feedback-purge [<reference> --confirm-reference <reference>]
```

To forward each report as a GitHub issue, set both `KIN_FEEDBACK_GITHUB_REPO`
(`owner/name`) and `KIN_FEEDBACK_GITHUB_TOKEN` (a fine-grained token for that
one repository with Issues read and write only); `KIN_FEEDBACK_GITHUB_API` may
name a GitHub Enterprise API over HTTPS. **Use a private repository**: the
typed text is whatever the person wrote. The service checks whether the
repository is private and says so in the preview. Forwarding runs in the
background with retries (1 minute doubling to 6 hours, giving up after 8
attempts or a refusal such as a bad token), is idempotent by reference, and
every 15 minutes mirrors the issue's state back as the report's status. The
token goes only to that API and is never logged.

## Optional: link a Google Play app

If you publish Kin as an Android app (a Trusted Web Activity,
[ANDROID](ANDROID.md)), Android checks `/.well-known/assetlinks.json` to
confirm the app and the site belong together. Set `KIN_ANDROID_PACKAGE` to
the app's package name and `KIN_ANDROID_CERT_SHA256` to its signing
certificate fingerprint (`AA:BB:…`, comma-separated if there are several).
With neither set the path answers 404; one without the other stops startup.

## What members' calendars mean for the server

Adults can sync a Google, Apple or Outlook calendar into Kin by pasting its
private iCal link. The service then downloads that calendar, at most every
30 minutes and only when a device in its audience asks, and relays it over
TLS. **It can read those calendars, and the database (server schema 29,
`calendar_subscriptions`) holds their private links in plaintext**, so treat
backups accordingly. The fetcher needs outbound HTTPS to the calendar hosts,
refuses private, loopback and link-local addresses after DNS resolution and
on every redirect (at most 5), and stops at 2 MB or 15 seconds. There is
nothing to configure.

## What the service does and doesn't guarantee

- It persists household identity, authorization metadata, opaque relay
  events and sync state. Sessions and in-flight passkey and pairing
  ceremonies expire on restart; members sign in again with a trusted device.
- A successful event response means its SQLite transaction committed, not
  that another device received it or that a backup exists.
- Sync is off for a household until an adult turns it on. Devices keep
  working offline and reconcile when they reconnect.
- The service has not had an independent security audit. The
  [known limitations](THREAT-MODEL.md#known-limitations-at-v10) list what it
  does not protect against.
