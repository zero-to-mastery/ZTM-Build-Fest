# ADR 0025 — Kin at home: a home server, a pass-through connection relay, names and certificates

Status: **Accepted** (#709, task #710, epic #708). The owner's decisions of
2026-10-22 (recorded on #711) are built in: option 2, a pass-through relay
with TLS ended on the home server; the Kin project runs a default relay on
journeytocode.io and publishes the relay as open source; a free name
`<name>.home.kin.journeytocode.io` by default, with the household's own
domain as an option; the Play Store app stays bound to
`kin.journeytocode.io` for now; the hosted service stays the easy default.
The connection relay (§1–§4) is built in `relay/` (#728; its deploy guide
is `relay/README.md`), and the packaging and `KIN_MODE` of §9–§10 in part
(#713; [HOME-SERVER](../HOME-SERVER.md)). The stories that build it are #713
(packaging), #718 (control panel), #723 (ACME client), #728 (relay), #733
(tunnel, home side), #737 (moving a household) and #740 (acceptance). Built
so far (#713, [HOME-SERVER](../HOME-SERVER.md)): `KIN_MODE` (§9), the
executables for Linux x64 and arm64, macOS arm64 and x64 and Windows x64,
built on any machine with Kin's own ELF, Mach-O and PE injectors (#714,
#747, #748; the macOS ones with Kin's own ad-hoc signature), the container
image, and installing as a service, on Windows as a real service run by
the Rust service host (#749, `tools/kin-service-host`: std only, stopping
Kin by closing its stdin, shipped beside the Windows executable), with the
Task Scheduler fallback when the host is missing.
Built by #733 (`server/home/`,
[HOME-SERVER](../HOME-SERVER.md#reaching-it-from-anywhere-the-tunnel)): the
home side of the tunnel (§2) with the home key, name claiming and
`SET_CAA` (§3, §5), reconnecting with backoff, on wake and on network
changes, TLS ended in the service with the ACME client (#723) started
(§9), and client addresses from `OPEN` for rate limits; the home settings
file `home/settings.json` (§9–§10), whose fields can also be set from
`KIN_HOME_*` environment variables for containers and technical
households. Direct LAN access stays deferred (§4). Built by #719 and #720
(`server/home/control-panel.mjs`, `setup.mjs`, `web/control/`;
[HOME-SERVER](../HOME-SERVER.md#setting-it-up-the-control-panel)): the
first-run setup page and the status page of the control panel (§10, §11),
with the additions and choices recorded at the end of §11. Scheduled
backups and restore are built by #721 (`server/home/backups.mjs`), and
signed updates by #722 (`server/home/release.mjs`, `updater.mjs`); the
choices are recorded at the end of §10.

**A word on names.** Kin's documents already call the sync service "the
relay" (it relays encrypted events; THREAT-MODEL S4, S5). This ADR adds a
different thing, so it always says **connection relay** for the new cloud
program and **home server** for the Kin service running in a household's
home. "The relay" alone keeps its old meaning elsewhere.

## Context

The owner wants a household to be able to run Kin on its own computer (a PC,
a Mac, a Raspberry Pi or a NAS) instead of the hosted service, and reach it
from anywhere without router changes (epic #708). Three ways in were
discussed: Tailscale, a pass-through relay, and a third-party tunnel. The
owner chose the pass-through relay.

Facts about Kin that shape the design (checked in the code on 2026-10-22):

- **The server is already small and self-contained.** It is a dependency-free
  Node program (`package.json` has no dependencies; `engines.node` is
  `>=24.16.0`). `server/start.mjs` is a launcher that starts
  `server/server.mjs` under Node's permission model (`server/permissions.mjs`):
  the service may read its app directory, read and write only its data
  directory, and may not start processes, workers, addons or WASI. Data is one
  SQLite file through `node:sqlite` (`server/durable-store.mjs`).
- **Its settings** are environment variables: `KIN_HOST` and `KIN_PORT` (the
  listener), `KIN_ORIGIN` (the public origin), `KIN_DATA_DIR` and
  `KIN_DATABASE_PATH`, `KIN_TRUSTED_PROXIES`, `KIN_ALLOW_NEW_HOUSEHOLDS` and
  `KIN_MAX_HOUSEHOLDS`, `KIN_PUSH_SUBJECT`, `KIN_FEEDBACK_GITHUB_REPO`,
  `_TOKEN` and `_API`, and `KIN_ANDROID_PACKAGE` and `KIN_ANDROID_CERT_SHA256`.
- **It never ends TLS itself.** `assertSecureOrigin` in `server/server.mjs`
  refuses any `KIN_HOST` that isn't loopback ("use a trusted TLS proxy for
  external access"); hosted deployments put Caddy in front
  (`deploy/README.md`).
- **It only sees encrypted household content.** Events, chat, the fridge,
  private storage and account vaults reach it sealed by devices
  ([ADR 0018](0018-account-key-vault.md), [ADR 0019](0019-member-private-log.md)).
  What it does see is in THREAT-MODEL "Metadata and anonymity".
- **The browser needs a secure context.** WebCrypto, passkeys, the service
  worker and installing the app all need HTTPS with a certificate the browser
  trusts (`http://localhost` is the only plain-HTTP exception). A LAN address
  such as `http://192.168.1.20:8000` fails.
- **Passkeys are bound to the name.** The service's WebAuthn relying-party ID
  is `new URL(origin).hostname` (`server/server.mjs`). The browser's storage,
  service worker and installed app are bound to the origin too. A household's
  address must be chosen once and kept.
- **Rate limits key on the client's address.** `server/client-key.mjs` reads
  `X-Forwarded-For` only from addresses listed in `KIN_TRUSTED_PROXIES`, and
  limits per IPv4 address or IPv6 /64. Bootstrap, pairing and report limits
  use it.
- **What the server sends out works from a home.** Web Push to the browsers'
  push services (`server/web-push.mjs`), outside-calendar downloads
  ([ADR 0022](0022-family-hub.md) §3, `server/calendar-fetcher.mjs`) and
  report forwarding ([ADR 0021](0021-kin-for-everyone.md) §3) are all
  outbound HTTPS.
- **Data is portable.** Household export and import exist
  ([PORTABILITY](../PORTABILITY.md)); an archive carries history, not
  authority. Backups exist too: `DurableStore.createBackup` copies the
  database with `VACUUM INTO` and verifies the copy (`node server/admin.mjs
  backup`).
- **Session cookies are host-only** (`kin_session`, `kin_device`:
  `HttpOnly; SameSite=Strict; Path=/`, no `Domain`), not `__Host-` prefixed.
- **The Play app** is a Trusted Web Activity bound to
  `https://kin.journeytocode.io` ([ADR 0020](0020-google-play-twa.md)).

## Decision

### 1. The shape: three parts, and where TLS ends

```text
phone ──TLS (end to end)──▶ connection relay :443 ──tunnel──▶ home server
                             reads the SNI only           (dialled out by the
                             splices bytes                 home server; ends TLS,
                                                           serves Kin)
```

- **The home server** is the Kin service in "home" mode (§9), packaged as one
  file per platform (§10). It dials **out** to the connection relay and keeps
  one tunnel open. It holds its own TLS key and certificate, ends TLS itself,
  and serves the app code, the API and the live channel. Nothing listens on
  the household's public address, so there are no open ports and no router
  changes.
- **The connection relay** accepts TCP connections on port 443, reads the
  server name (SNI) from the TLS ClientHello, and splices the connection's
  bytes, still encrypted, into the tunnel of the home server that owns that
  name. It **holds no certificate and no key for any home server's name** and
  ends no TLS for them. It also answers DNS for its zone (§4) and keeps the
  name registry (§3).
- **The phone** talks TLS to the home server, end to end. To the browser the
  home server is an ordinary HTTPS site with a publicly trusted certificate.

The connection relay does end TLS for **its own** name (for example
`relay.kin.journeytocode.io`), which is where home servers connect their
tunnels. That TLS protects the tunnel's framing and the home server's sign-in
to the relay; the household's connections inside the tunnel are a second,
separate TLS session that the relay can't open.

### 2. The tunnel protocol (KTUN version 1)

**Connection.** The home server opens TLS 1.3 to the relay's own name on
port 443, with ALPN `kin-tunnel/1`, and checks the relay's certificate in the
normal WebPKI way. The relay recognises a tunnel by its own SNI plus that
ALPN; any other connection to its own name gets a one-line status page and is
closed.

**Byte layout.** All integers are little-endian, as in Kin's other binary
formats (KSEV/KSEP in `web/sync/envelope-wire.js`, the WASM ABI).

```text
Preface (home server → relay, once, first 8 bytes):
  "KTUN"  version:u16 = 1  flags:u16 = 0

Frame (both ways, after the preface):
  type:u8  flags:u8  reserved:u16 = 0  stream:u32  length:u32  payload:length

  header 12 bytes; payload at most 16,384 bytes for every type
```

| Type | Name | Direction | Stream | Payload |
| --- | --- | --- | --- | --- |
| 1 | `HELLO` | relay → home | 0 | `nonce:32 maxStreams:u32 streamWindow:u32 connectionWindow:u32 pingSeconds:u16 idleSeconds:u16 reserved:u32` (52 bytes) |
| 2 | `AUTH` | home → relay | 0 | `publicKey:32 signature:64 softwareVersion:u32 reserved:u32` (104 bytes) |
| 3 | `READY` | relay → home | 0 | `count:u16 reserved:u16`, then `count` × (`nameLength:u8 name`): the names now routed to this tunnel |
| 4 | `OPEN` | relay → home | n ≥ 1 | `family:u8 nameLength:u8 reserved:u16 address:16 name:nameLength` |
| 5 | `DATA` | both | n ≥ 1 | the connection's bytes; flag bit 0 `FIN` means "I won't send more" |
| 6 | `WINDOW` | both | 0 or n | `increment:u32` (4 bytes) |
| 7 | `RESET` | both | n ≥ 1 | `code:u32` (4 bytes): drop this stream now |
| 8 | `PING` | both | 0 | `opaque:8` (8 bytes); flag bit 0 `ACK` marks the answer |
| 9 | `GOAWAY` | both | 0 | `lastStream:u32 code:u32` (8 bytes) |
| 10 | `CONTROL` | both | 0 | `requestId:u32 op:u8 status:u8 bodyLength:u16 body` (name registry, §3) |

Codes (`RESET`, `GOAWAY`, `CONTROL` status): 0 none, 1 protocol error,
2 authentication failed, 3 replaced by a newer tunnel, 4 limit reached,
5 name suspended, 6 unknown name, 7 relay overloaded, 8 shutting down,
9 name taken or retired, 10 name not allowed.

Every frame is checked before it is acted on: an unknown type, a fixed-size
payload of the wrong length, a reserved field that isn't zero, a stream
number that is wrong for the type, or a length over 16,384 is a protocol
error: the receiver sends `GOAWAY` with code 1 and closes the tunnel. A
future version changes the preface version; a relay refuses a version it
doesn't speak.

**Signing in.** Each home server has an **Ed25519 key pair** (the "home
key"), made on first run and kept in its data directory (§10). After the
preface the relay sends `HELLO` with a fresh random 32-byte nonce. The home
server answers with `AUTH`: its public key and an Ed25519 signature over

```text
"kin-tunnel-auth/1" 0x00 relayName 0x00 nonce(32) exporter(32)
```

where `exporter` is 32 bytes of TLS keying material exported from the tunnel's
own TLS session (RFC 8446 §7.5, label `EXPORTER-kin-tunnel-auth`, no
context). Binding the signature to this TLS session means a signature can't
be replayed on another connection or relayed through a machine in the middle.
The relay answers `READY` with the names bound to that key, or `GOAWAY` with
code 2.

**Streams.** Only the relay opens streams: one per incoming phone connection,
numbered from 1, increasing by one, never reused on that tunnel. Near 2³¹ the
relay sends `GOAWAY` and the home server reconnects. `OPEN` carries the name
the phone asked for (lowercase) and the **phone's IP address** (`family` 4 or
6; an IPv4 address fills the first 4 bytes of `address`, the rest zero). The
first `DATA` on a stream starts with the ClientHello bytes the relay read,
unchanged. Either side ends its direction with `FIN`; a stream is finished
when both have, or at once on `RESET`.

**Flow control (credits).** Each side starts with the windows the relay
announced in `HELLO`: by default 256 KiB per stream and 4 MiB for the whole
tunnel. Every `DATA` payload uses up credit in both its stream's window and
the tunnel's. A receiver grants more with `WINDOW` (stream 0 for the tunnel,
n for a stream) once it has passed data on, normally after half a window.
Sending more than the credit allows is a protocol error. When a stream's
credit runs out, the relay stops reading from that phone's TCP socket, so TCP
pushes back on the phone, and the relay never buffers more than one window
per stream. The home server does the same with its TLS socket.

**Keep-alive.** If nothing has arrived for `pingSeconds` (default 25), a side
sends `PING`; the other answers at once with `ACK`. If nothing at all has
arrived for `idleSeconds` (default 75), the tunnel is dead and is closed.
25 seconds keeps home routers' NAT entries alive without being chatty.

**Reconnecting.** After a lost tunnel the home server waits a random time
between 0 and the current backoff (1 second, doubling to 5 minutes; full
jitter), and resets the backoff after 60 seconds connected. It reconnects
at once, without waiting, when the operating system reports a network
change, or when the clock jumps by more than two ping intervals (the computer
slept). A new authenticated tunnel for the same key **replaces** the old one
(the old one gets `GOAWAY` code 3), so a half-dead tunnel can't hold the name.
Streams on a lost tunnel are lost: the relay closes those phones' sockets,
and the browser retries. Kin's sync already retries and resends idempotently,
and the live channel reconnects on its own.

**The client's address and rate limits.** On the home server, each stream is
handed to Node's TLS server as a socket whose peer address is the one in
`OPEN`, not the loopback address of anything in between. `clientKey`
(`server/client-key.mjs`) uses it exactly as it uses a direct peer today
(one limit per IPv4 address or IPv6 /64), and **ignores `X-Forwarded-For` on
tunnel streams**, because no proxy sits between the relay and the home server.
This is `KIN_TRUSTED_PROXIES` adapted: the tunnel is the one trusted proxy,
it reports the address outside the HTTP request where a phone can't forge it,
and the home server trusts the address only on streams from the
authenticated tunnel. Requests on the loopback listener keep today's rules.
A dishonest relay could put a false address in `OPEN`; the most it gains is
to share or dodge rate limits, which it could already do by withholding
traffic.

### 3. Names: claimed once, bound to the key, never reassigned

**Why a name must never change, and never pass to someone else.** A
household's passkeys are bound to the name (the WebAuthn relying-party ID),
and so are each browser's IndexedDB, service worker, installed app and
cookies for that origin. If the name changed, every device would start empty
and every passkey would stop working. If a name passed to a **different**
home server, that server would be the same origin to every device that ever
used the name: its code would run against the old household's stored data
(encrypted, but a page from that origin could ask for the password) and
could ask for those passkeys. So a name, once used, belongs to one home key
forever.

**Hostname rules.** A free name is one DNS label under the relay's zone:
3 to 40 characters, lowercase letters `a–z`, digits and hyphens (LDH), not
starting or ending with a hyphen, and no hyphen in both the third and fourth
places (that pattern is reserved for internationalised names, `xn--`). Names
are compared in lowercase. A reserved list kept in the relay's source
refuses names such as `www`, `relay`, `ns1`, `ns2`, `mail`, `admin`, `api`,
`kin`, `home`, `help`, `support`, `status`, `login`, `account`, `secure`,
`acme`, `test` and `example`, and the relay operator can add to it.

**Claiming.** Over an authenticated tunnel, the home server sends `CONTROL`
op 1 `CLAIM` with the name. The relay binds it to the home key if the name
follows the rules, isn't reserved, has never been claimed, and the limits
below allow it. One home key holds **one** free name.

**Keeping.** A name stays bound while its key keeps connecting. A name whose
key hasn't connected for 365 days stops routing and its DNS answers stop
(§4), but it stays bound to that key: connecting again with the key brings
it back. It is never offered to anyone else.

**Checking (added by #719).** `CONTROL` op 7 `CHECK`, with the name, asks
without binding anything whether this key could have it: the answer is what
`CLAIM` (a name in the zone) or `ADD_DOMAIN` (any other name) would say,
or "unknown name" for an own domain whose TXT record doesn't name the key
yet. It is limited to 30 a minute per key and counts toward no claim limit.
The setup page uses it for a live availability check over a sign-in-only
tunnel. A relay without it answers status 1, which the home server reads as
"can't check ahead"; the claim still decides.

**Releasing.** `CONTROL` op 2 `RELEASE`, from the key, stops routing and
retires the name: it can never be claimed again, by anyone, including the
same key. The control panel says so in plain words and needs fresh
confirmation (§11).

**Moving to a new machine.** The normal path is the backup: a restored backup
includes the home key (§10), so the new machine is the same home server.
For a deliberate change of key, `CONTROL` op 6 `TRANSFER` sends the name,
the new public key and the new key's signature over
`"kin-tunnel-transfer/1" 0x00 name 0x00 oldKey(32) newKey(32)`, on a tunnel
signed in with the old key. The relay rebinds the name, and the CAA record
is cleared until the new key sets one (§5).

**Anti-squatting.** Names are never recycled, so squatting would burn names
for good, and claims are limited:

- one free name and two own domains per home key;
- three claims per source address (IPv4 address or IPv6 /64) per day, and
  ten per 30 days;
- while the Public Suffix List entry is not yet in use by Let's Encrypt
  (§5), at most 20 new names across the whole relay per week, with a waiting
  list;
- a name that hasn't got a certificate within 7 days of its claim is
  released and may be claimed again: without a certificate no browser can
  have stored anything for it, so it is the one case where reuse is safe.

The relay operator can **suspend** a name (it stops routing; `GOAWAY` code
5) after an abuse report. Suspension never moves the name to another key.

**The household's own domain.** A household may use its own name, such as
`kin.smith.family`, instead of a free name. The household's DNS keeps
**A/AAAA records pointing at the relay's published addresses** (not a CNAME:
CAA lookups follow a CNAME, which would hand CAA back to the relay's zone)
and a TXT record `_kin-relay.kin.smith.family` holding the base64url SHA-256
of the home public key. `CONTROL` op 4 `ADD_DOMAIN` asks the relay to route
it; the relay checks the TXT record before routing and again daily. The
household sets its own CAA record (§5); the control panel shows the exact
records and checks them.

**One origin per home server.** `KIN_ORIGIN` names one origin and WebAuthn
has one relying-party ID, so a home server serves exactly one name: the free
name or the household's own domain, chosen during setup. Changing it later is
a move, with the consequences in §12.

### 4. The connection relay: SNI, DNS, limits and logs

**Reading the SNI.** The relay reads the start of each connection and parses
only enough of the ClientHello to find the server name:

- It reads at most **16 KiB** of ClientHello, in at most **4 TLS records**,
  within **10 seconds** of the connection opening; anything more or slower is
  closed. (Post-quantum key shares make a ClientHello around 1.2–2 KB, and it
  can span records or TCP segments.)
- Each record header must be content type 22 (handshake), a legacy version
  with major byte 3, and a length from 1 to 16,384. The handshake message must
  be type 1 (ClientHello) with a length that fits the bound.
- Every length is checked against the bytes that remain: the legacy version
  and 32-byte random, the session ID (0–32 bytes), the cipher suites (an even
  number of bytes, at least 2), the compression methods (at least 1 byte),
  and the extensions block, which must end exactly at the end of the
  message.
- It walks extension headers (type and length) and **interprets only type 0,
  `server_name`**. All other extensions are skipped by their length and never
  read. A second `server_name` extension is malformed.
- `server_name` must hold exactly one entry, of type 0 (host name), 1 to 253
  bytes, made of LDH labels of 1 to 63 characters separated by dots, with no
  trailing dot. It is lowercased.
- An SSL 2.0-style hello, a ClientHello with no SNI, and anything malformed
  are closed without a reply. A well-formed hello for a name the relay
  doesn't route gets a TLS `unrecognized_name` alert and is closed.
- After a match, the relay sends `OPEN` and then every byte it read, exactly
  as received, and splices the rest both ways. It never writes into the
  stream and never parses it again.

The parser is a small pure function with fixed bounds, tested with fixed
vectors and fuzzed (#728).

**Encrypted Client Hello (ECH).** With ECH, the real name is encrypted and
the visible (outer) SNI is a public name from the site's ECH configuration,
so an SNI router couldn't route it. Browsers send real ECH only when the
name's DNS publishes an ECH configuration (an `ech` parameter in an HTTPS
record). So:

- **The relay's DNS publishes none.** For HTTPS (type 65) queries on its zone
  it answers with no record. This is a requirement on any relay, written in
  the relay's operator guide.
- **Own domains must publish none.** The control panel checks the domain's
  HTTPS record and refuses the domain if it has an `ech` parameter (some DNS
  providers add one automatically).
- **GREASE ECH is harmless.** Browsers may send a fake ("GREASE") ECH
  extension; its outer SNI is the real name, and the relay doesn't read the
  extension.
- The consequence is that the name a phone connects to is visible to anyone
  on the path, as it is for most websites today (THREAT-MODEL).

**DNS.** The relay includes a small authoritative DNS server for its zone
(UDP and TCP port 53, no recursion), so anyone can run a relay by delegating
a subdomain to it, without a DNS provider's API. It answers:

- `A`/`AAAA` for routed names: the relay's own addresses;
- `CAA` per name from the registry (§5), and `0 issue ";"` at the zone's top
  so names nobody has claimed can't get a certificate;
- `NS` and `SOA` for the zone; no `HTTPS` records; `NXDOMAIN` for names that
  aren't routed.

DNSSEC signing is not in the first version (consequences in §5).

**Limits.** Defaults, adjustable by the relay operator:

| Limit | Default |
| --- | --- |
| Open phone connections per name | 256 |
| New phone connections per client address per name | 60 a minute |
| ClientHello read time and size | 10 seconds, 16 KiB, 4 records |
| Idle phone connection | closed after 15 minutes with no bytes either way (the live channel pings well within this) |
| Bandwidth per name | 20 Mbit/s sustained, 50 GB per 30 days |
| Tunnels per home key | 1 (a newer one replaces the older) |
| Tunnel sign-in attempts per source address | 30 an hour |
| Name claims | §3 |

Kin's own traffic is small (encrypted events, photos up to their existing
limits), so these limits only bite on misuse. Above a limit, new connections
for that name are refused and the home server's control panel shows why.

**What the relay logs, and for how long.**

- **Registry (kept while the name exists):** each name, the SHA-256 of its
  home public key, the date it was claimed, the last day (not time) its key
  connected, its own domains, its CAA account URI, and whether it is
  suspended. Retired names are kept forever as the name and the key hash
  only, so they are never given out again.
- **Counters (kept 30 days):** per name and per hour, the number of phone
  connections and the bytes each way, for limits and abuse reports.
- **In memory only, never written to disk:** client addresses, for the rate
  limits above, forgotten after 24 hours at most; the home server's address
  while its tunnel is open.
- **Errors:** an error code and a count; never a client address, never any
  byte of a stream.
- **Not kept anywhere:** per-connection records, connection times, which
  client address talked to which name, and the bytes of any stream. There are
  no access logs.

**Abuse.** Because the relay can't see inside connections, someone could use
a name for something other than Kin. The relay publishes an abuse address;
the operator can suspend a name after a report and can look at the name's
public pages like anyone else. That is the whole of it: the relay can't
inspect content, by design.

**Open source, and who runs it.** The relay is a dependency-free Node
program in this repository (`relay/`, #728), with a deploy guide. The Kin
project runs the default relay for `home.kin.journeytocode.io`. Anyone can
run their own for their own zone; a home server's relay address and zone are
settings, with the Kin project's as the defaults.

**When the relay is down.** The relay is a single point of failure for
**reaching** the home server, not for the household's data. Devices are
local-first ([ADR 0006](0006-local-first.md)): they keep working, keep their
changes in the outbox and sync when the relay or the home server is back.
The home server keeps running, sending push and syncing calendars, and
reconnects by itself (§2).

**Direct LAN access: deferred.** Reaching the home server inside the house
without the relay would need the phone to resolve the same name to the home
server's LAN address, because a different name is a different origin
(no data, no passkeys). The ways to do that don't fit a non-technical
household today:

- **Split-horizon DNS** needs control of the router's DNS, which most
  households don't have.
- **mDNS** only resolves `.local` names, which are a different origin and
  can't get a public certificate.
- **The home server answering DNS** on the LAN would also need the router to
  hand it out as the DNS server.

The home server would also have to listen on a LAN address, which
`assertSecureOrigin` forbids today; that rule exists because the service
expects a TLS proxy in front, and a home server ending its own TLS could
lift it in home mode. Phones at home go out to the relay and back, which
works, with some extra latency. A documented advanced option (for example a
household with its own DNS server pointing its own domain at the home server)
is left for a later story.

### 5. Certificates: the home server's own ACME client

**Who gets the certificate.** The home server runs its own ACME client
(RFC 8555, written from scratch, #723) against Let's Encrypt. Its ACME
account key is ES256 (P-256). The certificate's private key, the account key
and the home key are made on the home server and **never leave it**; they are
stored in its data directory, readable only by the account Kin runs as (§10).
The relay never has them.

**Challenge: TLS-ALPN-01 (RFC 8737), not HTTP-01.** Let's Encrypt connects to
the name on port 443 with ALPN `acme-tls/1`. The relay routes it by SNI like
any other connection; the home server sees the ALPN, answers with a
self-signed certificate carrying the `acmeIdentifier` extension, and closes.

Why TLS-ALPN-01:

- **The relay stays an SNI router and nothing else.** HTTP-01 would need the
  relay to accept plain HTTP on port 80, parse each request's `Host` header
  and forward it: a second parser, and a plaintext path into the home server.
  With TLS-ALPN-01 the relay needs nothing new.
- **It proves the real path.** The challenge travels exactly the way phones
  will, so a passed challenge means the name, DNS, relay and tunnel all work.
- **CAA can name the method** (`validationmethods`, RFC 8657), narrowing
  issuance further.
- **It works the same for own domains.**
- **The cost:** the home server must build the challenge certificate itself
  (DER, signed with Node's `crypto`), with the same DER writer the CSR needs
  anyway. TLS-ALPN-01 can't issue wildcard certificates, which Kin doesn't
  need.

The relay listens on port 80 only to answer every request with a redirect to
the same name over `https://`; it forwards nothing on port 80.

**Renewal.** The home server follows ACME Renewal Information (ARI) when Let's
Encrypt offers it, and otherwise renews when two thirds of the certificate's
lifetime has passed. Failures retry with backoff (1 hour doubling to 24
hours). The control panel shows the expiry date, and admins get a
content-free push when the certificate has less than 14 days left. Let's
Encrypt is shortening certificate lifetimes; renewal by ARI or by fraction of
lifetime follows that without changes.

**Rate limits and the Public Suffix List.** Let's Encrypt allows **50 new
certificates per registered domain per week**; renewals of the same names are
mostly exempt (ARI renewals fully). It works out the registered domain from
the Public Suffix List (PSL). Without a PSL entry, every free name is under the
registered domain `journeytocode.io`, so all new home servers, the hosted
service and the project's blog would share those 50 a week. The Kin project
will **request a PSL entry for `home.kin.journeytocode.io`** (private
section, with the `_psl` TXT record the PSL requires) before free names open.
Consequences:

- **Each free name becomes its own registered domain**, with its own 50 a
  week. Let's Encrypt uses a copy of the PSL that lags the list.
- **Cookies.** Browsers refuse cookies set for a public suffix or wider than
  the registered domain. A home server at `x.home.kin.journeytocode.io` can
  then no longer set a cookie with `Domain=home.kin.journeytocode.io`,
  `kin.journeytocode.io` or `journeytocode.io`. Without the entry it could:
  that is "cookie tossing", and the hosted service's cookies (`kin_session`,
  `kin_device`) are plain names that a tossed cookie could shadow. So, as well
  as the PSL entry, Kin's session cookies move to `__Host-` names on HTTPS
  origins (accepting the old names for a transition), which browsers only
  accept as host-only, Secure and `Path=/`.
- **Separate sites.** Browsers treat each name as its own site for storage
  partitioning, `SameSite` and reputation (a Safe Browsing block on one name
  doesn't spread to the others or to `kin.journeytocode.io`).
- **Lead time.** The PSL is maintained by volunteers. Review, merging and the
  entry reaching browsers' releases and Let's Encrypt's copy takes months;
  plan on **six months**. Entries are hard to remove later. Until it is in
  use, the relay caps new names at 20 a week (§3), and the project may ask
  Let's Encrypt for a rate-limit adjustment.

**CAA bound to the household's ACME account (RFC 8657).** For each free name
the relay's DNS serves

```text
<name>.home.kin.journeytocode.io. CAA 0 issue "letsencrypt.org; accounturi=<the home server's account URL>; validationmethods=tls-alpn-01"
<name>.home.kin.journeytocode.io. CAA 0 issuewild ";"
```

The home server sets the account URL with `CONTROL` op 3 `SET_CAA`, signed in
with its home key, **before** its first order. Let's Encrypt then issues for
that name only to that ACME account. Names nobody has claimed fall back to
the zone's `0 issue ";"` and get nothing. For an own domain, the household
publishes the same records in its own DNS; the control panel shows them and
checks them.

**The residual risk, stated plainly.** For a free name, **the relay operator
controls the DNS for the zone and carries the challenge traffic**. An
operator who turned malicious (or someone who took over the relay) could
change the CAA record, answer a TLS-ALPN-01 challenge with their own account,
and get a valid certificate for a household's name. With it they could
answer that household's phones as the home server: serve their own app code,
which would then run as Kin in the browser and could ask for passwords or
read what the unlocked app decrypts. CAA alone can't stop the party that
controls the DNS. What limits it:

- **Detection by Certificate Transparency.** Every publicly trusted
  certificate is logged. The home server checks a CT search service (crt.sh
  by default, configurable) for its own name once a day and compares each
  certificate's public key with the ones it made. Any other certificate turns
  the control panel red and sends admins a content-free push. Detection
  comes after the fact: phones that connected in between were exposed.
- **Own domains** keep DNS and CAA under the household's control. The relay
  then can't get a certificate (it doesn't hold the household's ACME account
  key, and CAA names that account), so the relay operator is reduced to
  dropping or delaying traffic. Households that don't want to trust the relay
  operator at all should use their own domain.
- **No DNSSEC at first.** Without it, someone who can spoof DNS answers to
  Let's Encrypt's resolvers could change CAA too; Let's Encrypt's checks from
  several network locations make that hard. DNSSEC for the relay's zone is a
  later improvement.

**App code always comes from the home server.** The relay never serves a
page, a script or a service worker for a home server's name: it can't, since
it has no certificate for it. Keeping all app code on the TLS session that
ends on the home server is what keeps the relay out of the household's
encryption. A relay that served code would be able to read everything.

### 6. What the connection relay can and cannot learn

| It can see | It cannot see |
| --- | --- |
| Each name, and which home key and home address (while connected) holds it | Anything inside the TLS sessions: pages, app code, API calls, events, chat, photos, cookies, passwords, passkeys |
| Phones' IP addresses and which name each connects to | Which member or device a connection belongs to |
| When connections open and close, how long they last, and bytes each way | The household's name, members or content |
| When the home server is online (tunnel uptime) | The home server's certificate key, ACME account key or home key |
| The SNI, and the start of each ClientHello (in clear on the wire anyway) | |

What it **keeps** is limited to the registry and 30 days of hourly counters
(§4). It could keep more if its operator changed the code; the open-source
relay is what the Kin project runs, but a household can't verify that from
outside. THREAT-MODEL and PRIVACY carry this table.

### 7. The home server's own threat notes

- **It is the household's server.** Everything the hosted service's operator
  can see ([THREAT-MODEL](../THREAT-MODEL.md), "Metadata and anonymity",
  reports and synced calendars), the person who runs the home server can see
  instead. Household content stays end-to-end encrypted as before.
- **It sits on the home network.** The calendar fetcher's guard against
  requests to private, loopback and link-local addresses
  (`server/calendar-fetcher.mjs`) matters more at home, where the LAN has
  printers, routers and cameras. It stays on, unchanged.
- **Its keys are the household's front door.** Whoever has the home key and
  the ACME account key (from the data directory or a backup) can claim the
  name's tunnel and get certificates for it, and so serve app code to the
  household. Backups are therefore as sensitive as the data directory (§10).

### 8. What stays outbound, and works from home

Web Push (to the browsers' push services), outside-calendar downloads (ADR
0022 §3), report forwarding (ADR 0021 §3), ACME, the CT check and update
checks are outbound HTTPS from the home server. They work from a home
connection without the relay, and keep working when the relay is down.

### 9. Server modes: hosted and home

A new setting **`KIN_MODE`**: `hosted` (the default, today's behaviour) or
`home`. In home mode:

- **New households are limited to the owner's.** `KIN_MAX_HOUSEHOLDS`
  defaults to 1 and new households close once it is reached
  (`KIN_ALLOW_NEW_HOUSEHOLDS` is set to false then). The control panel can
  raise it to a small number (for example for grandparents' own household),
  with fresh confirmation. Invitations into existing households keep working.
- **The admin command becomes the control panel.** What `server/admin.mjs`
  does for an operator today (backup, restore, household status, reports) is
  offered in the control panel (§11).
- **Hosted-only settings are off.** `KIN_ANDROID_PACKAGE` and
  `KIN_ANDROID_CERT_SHA256` are refused at startup in home mode: the Play app
  is bound to `kin.journeytocode.io` (ADR 0020) and connecting it to home
  servers is a separate, later decision. `KIN_FEEDBACK_GITHUB_*` stays
  available but is off by default: the project's token can't be given to home
  servers, so reports stay on the home server for its admins.
- **TLS ends in the service.** The service takes tunnel streams and ends TLS
  for its one name with Node's `tls` module, choosing the certificate by SNI
  and answering `acme-tls/1` with the challenge certificate (§5). It listens
  only on loopback (for the control panel) and opens no public listener.
- **Settings it writes for itself:** `KIN_ORIGIN` becomes
  `https://<the chosen name>`. The relay address and zone, the backup
  schedule and the update policy are home settings kept in the data directory
  and changed in the control panel.
- **Unchanged:** push (`KIN_PUSH_SUBJECT` still defaults to the origin),
  calendar sync, the sandbox, the database and every format.

### 10. Packaging, running, updating and backing up

**One file per platform.** The home server ships as a Node **single
executable application** (SEA) with the web app, the WASM engine, the server
and the relay client inside, for Windows x64, macOS arm64 and x64, and Linux
x64 and arm64 (Raspberry Pi), plus a **container image** for NAS and server
users, with the data directory as a volume (`/data`). Building the SEA uses
Node's own SEA support; the blob is injected without the `postject` npm
package (a Kin build script that writes the executable's resource section, or
Node's built-in builder where the build machine's Node has one). Built
(#714, #747, #748): `scripts/sea/elf.mjs` (a note in a new segment),
`scripts/sea/macho.mjs` (a `NODE_SEA` segment, with an ad-hoc code
signature from `scripts/sea/codesign.mjs` in place of node's own) and
`scripts/sea/pe.mjs` (an `RT_RCDATA` resource, node's Authenticode
certificate removed), all checked by parsing the result back. No
dependency is added. The launcher stays the only part that starts processes,
and the service still runs under the permission model; how a SEA passes those
flags to its own service process is settled in #713: it starts a second
copy of itself with them in `NODE_OPTIONS`, after unpacking its app files to
a checked, read-only cache folder that becomes the service's app directory
([HOME-SERVER](../HOME-SERVER.md)).

**The data directory.** Defaults: `%ProgramData%\Kin` on Windows,
`/Library/Application Support/Kin` on macOS, `/var/lib/kin` on Linux,
`/data` in the container; `KIN_DATA_DIR` overrides it. It holds the database,
`home/` (the home key, the ACME account key, the certificate and its key, and
the home settings) and `backups/`. Files are created readable only by the
account Kin runs as (mode 0600 on macOS and Linux; on Windows an ACL for that
account and Administrators).

**Running as a service.** An installer step, run from the control panel or
the first-run page with the operating system's admin prompt:

- **Linux:** a systemd unit (`kin.service`) running as a `kin` user,
  `Restart=on-failure`, `StateDirectory=kin`, and hardening (`NoNewPrivileges`,
  `ProtectSystem=strict`, write access only to the data directory).
- **macOS:** a launchd **LaunchDaemon** plist
  (`/Library/LaunchDaemons/io.journeytocode.kin.plist`) with `UserName` set to
  the installing user, `RunAtLoad` and `KeepAlive`, so Kin starts at boot
  without anyone logging in and doesn't run as root.
- **Windows:** a service registered with `sc.exe create`, starting at boot,
  with restart-on-failure set by `sc.exe failure`. A plain console program
  can't answer the Service Control Manager (it would fail with error 1053),
  so the registered program is a small **service host written in Rust with
  only `std`**, declaring the few `advapi32` functions it needs by hand (no
  crates). It reports the service's state and starts and stops the Kin
  launcher. If that proves impractical in #713, the fallback is a Task
  Scheduler task at startup.
- Uninstalling removes the service and leaves the data directory unless the
  person asks to delete it.

**First run.** The launcher starts the service on loopback and opens the
browser at `http://localhost:<port>/setup` with a **one-time setup code**
(10 characters from an unambiguous alphabet, valid for one hour, used once),
which it also prints to its log for a computer without a screen. The
setup page asks for the code, then: choose the name (or own domain), connect
to the relay, get the certificate. Then it sends the person to
`https://<name>` to create the household **there**, because passkeys and the
device's storage must belong to the real name, not to `localhost`.

**Updates, signed.** The Kin project signs each release with an **Ed25519
release key** that the owner keeps offline; its public key is built into the
home server. Each release has a manifest (version, platform, file size,
SHA-256, minimum version to update from) and a detached 64-byte Ed25519
signature over the manifest's exact bytes. The launcher, outside the sandbox:

1. checks for a new manifest daily and verifies its signature;
2. downloads the file and checks its size and SHA-256;
3. makes a backup (below);
4. keeps the current executable as the previous version and puts the new one
   in its place;
5. restarts and **health-checks**: `GET /health` must answer within 60 seconds
   and the service must stay up for 5 minutes;
6. if not, **rolls back**: puts back the previous executable and the
   pre-update backup (a newer server schema can't be read by an older server)
   and reports it in the control panel.

Events that reached the home server between the backup and the rollback are
still on the devices that wrote them, which resend them (THREAT-MODEL,
"Remaining Limitations": a relay reset is detected and cached envelopes are
requeued). A new release key is introduced by a manifest signed by the old
one. By default patch and minor releases install automatically at night
after the backup; major releases wait for an admin.

**Backups.** The launcher runs the existing verified backup
(`DurableStore.createBackup`, which copies the database with `VACUUM INTO`
and checks the copy) on a schedule: daily at 03:00 local time by default,
keeping the **14** newest copies in `backups/`, and optionally copying each
to a second folder the person chooses (a USB drive). Each backup set also holds
a copy of `home/` (the home key, ACME account key and certificate), so a
restore on a new computer is the same home server with the same name. The
control panel says plainly that a backup can be used to impersonate the home
server and must be kept as private as the computer. Restore stops the
service, uses the existing restore (`server/admin.mjs restore`), and starts
it again.

*As built (#721).* Two choices this section didn't make:

- **The service runs the schedule, not the launcher.** The sets live in
  `backups/` inside the data directory, which the sandboxed service may
  write, and the service already has the database, a clock and the control
  panel the status and changes go through; a launcher-run backup would need
  a second channel to the panel. Only the optional copy to a second folder
  writes outside the data directory, so that copy is the launcher's (*As
  built (#763)*, below). A backup is due when the newest set is older than the latest
  scheduled hour, so a computer that was off at 03:00 catches up when it
  starts; a failure waits an hour before the next try.
- **Restore runs at the next start, inside the service.** The panel checks
  the set opens, writes `backups/restore.json` and exits with the restart
  code (as setup does). On the next start, before the database is opened,
  `DurableStore.restoreBackup` puts the set back (its paths are all in the
  data directory) and the outcome is shown in the panel; a refused restore
  leaves the current database and Kin starts normally. The set's `home/` is
  put back only on a computer with no home key yet (moving to a new
  computer, offered on the setup page before a name is chosen); on a server
  that has one, its own keys stay.

*As built (#763).* The copy to a second folder:

- **The launcher keeps the folder in step by looking again.** The
  service's `home_backup_created` line, the launcher starting and a look
  every minute each copy any finished set the folder lacks, newest first.
  That covers the set the updater makes before an update (in the launcher,
  so no line) and a drive plugged in later; a missed line does no harm.
  The minute's look also checks the folder after a good copy, so a drive
  unplugged, or another one at the same place, is noticed within a minute.
  A folder changed during a run gets no more sets.
- **The folder is `backupCopyFolder` in `home/settings.json`, chosen only in
  the panel on the home server's own computer**, because the copies hold
  every household's data and the home key: a change can be marked
  loopback-only, and any caller that doesn't say it is the loopback panel
  is refused. The service checks only the value's form (it may not look
  outside its data directory); the launcher checks the folder itself. A
  stored path that doesn't suit this computer (after a move to another
  kind of computer) turns the copy off rather than stopping Kin.
- **Copies go to `<folder>/Kin backups/<name>/kin-<time>/`**, in the set
  format, the database read back and checked (which catches Kin's own
  mistakes, not a drive that loses writes), the manifest written last and
  each file flushed. Kin never makes the chosen folder and refuses one on the
  data directory's own partition, or (outside Windows) one under `/media`,
  `/mnt`, `/run/media` or `/Volumes` when neither it nor any folder above it
  up to the one directly under that area is on another partition than its
  parent (a drive mounted at `/mnt` itself is used; `/Volumes`, on its own
  partition on a Mac with nothing mounted at it, never counts as one), so a
  missing or unmounted drive is reported and never fills the system
  disk. Another partition of the same disk can't be told apart. On Windows
  `Kin backups/<name>` gets the data directory's kind of permissions (SYSTEM,
  Administrators, the owner, LOCAL SERVICE and the running account by SID,
  so a folder first made by an interactive run still lets the service in).
  FAT32 and exFAT hold none, and an NTFS folder Kin may not change fails
  the same way: the copy goes ahead, `copy-status.json` records
  `notPrivate` for the panel, and the next look tries again. The 14-newest rule applies there, touching
  only Kin's own folders (two servers can share a drive), and a full drive
  is reported, not cleared.
- **The outcome goes to `backups/copy-status.json`**, which only the
  launcher writes, as with `updates/status.json`. The remote panel sees the
  state, dates and codes, never the folder's path.
- **The Linux unit allows writes to `/media`, `/mnt` and `/run/media`**
  (`ReadWritePaths`), since `ProtectSystem=strict` would make them read-only
  for the launcher too; the service stays confined to its data directory by
  the permission model. An install from before this needs
  `kin --install-service` again.

*As built (#722).* With the owner's answers of 2026-10-25:

- **Releases come from GitHub Releases** of the project's repository: the
  manifest and its signature from `releases/latest/download/`, each file
  from its `kin-v<version>` tag. `KIN_HOME_RELEASES` names another base for
  a fork.
- **No release key is built in yet.** `scripts/release-key.mjs` makes the
  key pair offline, `scripts/sign-release.mjs` signs a build; until the
  public key is in `server/home/release-key.mjs`, updates are off and Kin
  makes no requests for them. Rotating the key needs no format: a release
  signed with the old key carries the new public key.
- **The account Kin runs as may write its install folder**, so the launcher
  can replace the executable; the service stays sandboxed to its data
  folder. A separate privileged updater was the alternative, at the cost of
  three platform-specific mechanisms.
- **The old launcher tries the new release before replacing anything**,
  instead of steps 4–6 above in that order: it unpacks the new release into
  its own cache folder, stops the service, backs up, and runs the new
  release as the service; only after the health check and 5 minutes up does
  it swap the files and keep the new service running. A release that fails
  is stopped, the backup's database is put back by replacing the file (a
  restore would have to open the newer schema), and the old service starts
  again. So a release that can't start never leaves a service manager
  restarting it, and nothing depends on how each one restarts a program.
- **"At night" is 02:00 to 05:00** local time; `autoUpdate: false` in the
  home settings (a control-panel setting) makes every release wait for an
  admin. A release that failed isn't installed by itself again.
- **Only Kin installed as a service updates itself.** Other copies (run by
  hand, a checkout, the container image) show the update and its page.

### 11. The control panel

The server's own pages are the control panel (#718); there is no separate
app. It shows: relay connected or not, certificate valid until, last backup,
storage used, households and devices (counts only, never content), version
and updates, and the CT check. It offers backups and restore, updates, the
name and own-domain records, new-household limits, and the reports the admin
command shows today.

**Who can use it:**

- **On loopback** (`http://localhost:<port>`): first with the one-time setup
  code, then with a control-panel session made during setup. A program on the
  same computer can reach loopback, which is why the code is needed.
- **Through the public name:** only a signed-in **household admin** of a
  household on that server.
- **Every change** (restore, update, release the name, raise limits, delete a
  household) needs a fresh confirmation: the admin's passkey, or their
  password for an admin without one, as elsewhere in Kin
  ([ADR 0018](0018-account-key-vault.md)).

**As built (#719, #720).** Where building it needed a choice this record
didn't make:

- **The page is `/control/`**, not `/setup`: one page for setup and status.
  The root address on loopback leads there.
- **The loopback panel has its own API** (`/control/api/*`) instead of a
  second app origin: a set-up server's app origin is `https://<name>` and
  stays the only one (`assertSecureOrigin`, the WebAuthn relying party and
  the app API's origin check are unchanged). It answers only loopback
  listener sockets (never tunnel streams), a loopback `Host` with the
  listener's port, no forwarding headers (and is off with
  `KIN_TRUSTED_PROXIES`), and same-origin JSON writes.
- **A fresh confirmation on loopback is a printed code.** An admin's passkey
  belongs to `https://<name>`, not `localhost`, and the loopback panel knows
  no member, so a change there needs a confirmation code Kin prints to its
  window and log (10 minutes, once, five tries), the same channel as the
  setup code. Through the public name it is the admin's passkey or
  password, as above.
- **Setup is confirmed by the setup code.** Choosing the name, agreeing to
  the terms and connecting happen before anything exists to protect, within
  the session the code opened, and are refused once a certificate exists.
- **Access codes after setup.** On loopback without a control session, the
  page asks Kin to print a new code (at most one every 30 seconds).
- **The restart.** Setup writes the name and asks the launcher to start the
  service again (exit code 75), so the service comes back with the new
  origin; tunnel, claim and certificate are then the ordinary home-mode
  start.
- **An own domain's ACME account is made at the terms step**, so the CAA
  record shown names it before the first order.
- **New-household limit** is the first change (1 to 10, `maxHouseholds` in
  the home settings; `KIN_MAX_HOUSEHOLDS` wins).
- **Certificate alerts** (§5) use the existing content-free push, sent to
  household admins' devices at most daily per kind; the control panel says
  what it is about.

### 12. Moving a household from the hosted service to a home server

*Superseded by [ADR 0026](0026-moving-a-household.md) (proposed): the
export can't start a household on another server, so the hosted service
sends the household's records to the home server instead. The plan as first
written:*

Uses what exists (#737):

1. An admin exports the household on the hosted service (PORTABILITY).
2. On the home server's address, the admin creates Kin from that export.
3. The other members re-join the new address through a guided invitation.
4. The old household on the hosted service is closed only after everyone
   has moved; nothing is deleted before that.

**Passkeys don't carry over.** They are bound to `kin.journeytocode.io`, and
the home server is a different name (the browser also starts with empty
storage there). Each person signs in at the new address with their password
or backup code and then adds a new passkey; the move screens say this in
plain words. A member's sealed account vault can come across because it is
already encrypted on their device: its password and backup-code wrappers
open it anywhere, while its passkey wrappers can't (the passkey's PRF output
belongs to the old name) and are dropped. #737 settles how the vault and the
household's server-side record come across.

The Play app stays with `kin.journeytocode.io`; people on a home server use
the installed web app from their own address (ADR 0020).

## Consequences

- **New code, all dependency-free:** the connection relay (`relay/`: SNI
  parser, KTUN, registry, authoritative DNS), the home side of the tunnel and
  TLS termination in the service, an ACME client with a DER writer, a CT
  checker, a launcher with updates, backups and service install, a Windows
  service host in Rust std, the control panel pages, and build scripts for
  SEA executables and the container image.
- **New formats:** KTUN 1 (tunnel framing), the registry's `CONTROL` ops,
  the release manifest and its signature, and the home settings file. None
  changes a v1.0 format; they are listed as planned in V1.0-COMPATIBILITY.
- **New settings:** `KIN_MODE`, plus home settings kept in the data
  directory. Existing settings keep their meaning; home mode refuses the
  Android ones.
- **The hosted service changes slightly:** `__Host-` session cookie names
  (with a transition), so a home server under the same domain can't shadow
  them.
- **Project tasks:** the PSL request (start early; months of lead time), the
  relay's operation and abuse address, the offline release key, and the
  relay's zone delegation.
- **Documents:** PRIVACY and THREAT-MODEL gain the relay's and the home
  server's sections (#712); an operator guide for the relay and a plain
  "Kin at home" guide come with #740, which also requires an independent
  security review of the relay, tunnel, SNI parser and ACME client.
- **The relay is a single point of failure for reaching home servers.**
  Devices keep working offline, and households can run their own relay.

## Alternatives considered

- **Tailscale.** A private WireGuard network between the household's
  devices; it already gives a `*.ts.net` name with a real certificate
  (`tailscale serve`). It needs the Tailscale app on every phone and an
  account, and every member's device joins the household's network, which is
  more than a grandmother should have to do. Tailscale's coordination service
  is a third party. **Still offered as a documented option** for technical
  households: run the home server in home mode behind `tailscale serve`, with
  `KIN_ORIGIN` set to the `ts.net` name; the relay isn't needed.
  (`deploy/README.md` notes the public test server exists so testers don't
  need Tailscale.)
- **Cloudflare Tunnel or Tailscale Funnel.** Both work without open ports.
  Cloudflare Tunnel ends TLS at Cloudflare, which then sees every page,
  script and request in clear and could serve its own app code. Funnel passes
  TLS through to the device, but needs Tailscale on the home server, a
  Tailscale account, and Tailscale's names and limits; it is a third-party
  service in the middle either way. Rejected as the default; a technical
  household can still use Funnel as with Tailscale above.
- **A relay that ends TLS.** Simpler (a normal reverse proxy with a wildcard
  certificate), but the relay would read every request and serve the app
  code, so it would be able to read everything. Rejected: it breaks the one
  promise the owner set ("the relay must never be able to read household
  traffic").
- **Port forwarding with dynamic DNS.** No relay at all, but it needs router
  changes, a public IPv4 address (many homes are behind carrier-grade NAT),
  and it exposes the home server's address and an open port to the
  internet. Too hard for the target household, and not always possible.
  Technical households can still do it with their own domain and a reverse
  proxy, as `deploy/` already shows.
- **HTTP-01 instead of TLS-ALPN-01.** Discussed in §5: a second, plaintext
  path through the relay for no gain.
- **A separate registered domain for home names** (instead of
  `home.kin.journeytocode.io`). It would separate cookies, Let's Encrypt
  limits and reputation from `journeytocode.io` from the first day, without
  waiting for the PSL. The owner chose the journeytocode.io subdomain; the
  PSL entry and `__Host-` cookies give the same separation once in place.
  See the owner's answers below.
- **Tauri or Electron wrappers.** A desktop app around the server would add
  large third-party runtimes and npm or crate dependencies, against Kin's
  zero-dependency rule (AGENTS.md, ADR 0007), and still need a browser
  for the phones. The server's own pages are the control panel instead.
- **Rewriting the server in Rust.** A single native binary without Node, but
  it would mean rewriting a large, tested service (sync, accounts, WebAuthn,
  push, calendar sync, SQLite) and its HTTP and TLS stack without crates.
  Node's SEA gives one file per platform with the code that exists. Rust is
  used only for the small Windows service host.

## Owner answers to the open questions (2026-10-22, recorded on #708)

1. **Signing for macOS and Windows:** unsigned for now. The guides show the
   Gatekeeper and SmartScreen warnings and how to get past them
   ([HOME-SERVER](../HOME-SERVER.md)); releases are checksummed. Buy an
   Apple Developer ID and a Windows code-signing certificate when Kin at home
   is offered widely.
2. **Claims without an account:** the home key only, with no email address,
   so the connection relay's registry holds no personal data. Abuse limits
   stay per key and per source address (§3).
3. **Free names** stay on `home.kin.journeytocode.io`: apply to the PSL now
   and use `__Host-` cookie names in the meantime (§9).
4. **Automatic updates:** as proposed. Patch and minor releases install at
   night with a backup and rollback; major releases wait for an admin.
5. **Reports from home servers:** allowed, as on the hosted service (ADR
   0021 §3), through a Kin project endpoint rather than a GitHub token on the
   home server. The home server's admin can turn it off.
