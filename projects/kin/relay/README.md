# The Kin connection relay

The connection relay lets phones reach a Kin **home server** (Kin running on
a household's own computer) without open ports or router changes
([ADR 0025](../docs/decisions/0025-kin-at-home.md), story #728). It is a
separate, dependency-free Node program. The Kin service never imports it,
except for the shared tunnel codec `ktun.mjs`.

```text
phone ──TLS (end to end)──▶ connection relay :443 ──KTUN tunnel──▶ home server
                             reads the SNI only        (dialled out by the home
                             splices the bytes          server; ends TLS itself)
```

- **It's a pure SNI router.** For each connection on port 443 it reads the
  ClientHello's server name and nothing else (at most 16 KiB, 4 TLS records,
  10 seconds). It forwards the bytes, still encrypted and exactly as
  received, into the tunnel of the home server that owns that name. It holds
  no certificate or key for any home server's name and never ends TLS for
  one.
- **Its own name** (for example `relay.kin.journeytocode.io`) is the one
  name it ends TLS for, with its own certificate. Home servers connect there
  with ALPN `kin-tunnel/1` and sign in with their Ed25519 home key. Anything
  else on that name gets a one-line status page with the abuse address.
- **Port 80** answers every request with a redirect to `https://` on the same
  name. It forwards nothing.
- **Port 53** is an authoritative DNS server for the relay's zone: A/AAAA for
  names that are routed, CAA per name, NS and SOA. It never publishes an
  HTTPS record (see "ECH" below).

## Files

| File | What it does |
| --- | --- |
| `start.mjs` | Starts the relay from `KIN_RELAY_*` settings, or in test mode with `--test` |
| `relay.mjs` | Port 443 routing, the relay's own TLS, port 80, limits, counters, the daily sweep |
| `sni.mjs` | The bounded ClientHello reader (#729) |
| `ktun.mjs` | KTUN v1, the tunnel codec shared with the home server (#730; [TEST-VECTORS](../docs/TEST-VECTORS.md#the-ktun-tunnel-730) 186–193) |
| `tunnel.mjs` | One tunnel on the relay's side: sign-in, streams, credit, keep-alive |
| `registry.mjs` | The name registry in SQLite (`node:sqlite`) (#731) |
| `limits.mjs` | Rate limits and bandwidth, held in memory only (#732) |
| `dns.mjs` | The authoritative DNS server |
| `admin.mjs` | The operator's commands: suspend, unsuspend, status, errors |
| `*.test.mjs` | The tests; `npm run verify` runs them with the rest of Kin |

## What it keeps, and what it never keeps

Exactly what ADR 0025 §4 allows:

- **The registry** (`registry.sqlite`), kept while a name exists: each name,
  the SHA-256 of its home public key, the day it was claimed, the last day
  (not time) its key connected, its own domains, its CAA account URI,
  whether it is suspended, and the day a certificate for it was first seen
  in Certificate Transparency (already public; it decides when an unused
  name may be claimed again). Released names are kept forever as the name
  and the key hash only, so they are never given out again. Keys waiting for
  a free name under the weekly cap are kept as key hashes, for 30 days at
  most.
- **Counters**, kept 30 days: per name and hour, phone connections and bytes
  each way.
- **Errors**: an error code and a count.
- **In memory only, never written:** client addresses, for rate limits, each
  forgotten when its window ends (24 hours at most), and the home server's
  address while its tunnel is open. The 10-claims-in-30-days limit is
  counted in a sketch of keyed hashes whose key is made at start and never
  stored, so it holds no address.
- **Never anywhere:** access logs, per-connection records, connection times,
  which address talked to which name, or any byte of a stream. The relay
  prints only its startup line and certificate reloads.

## Running it

On Oracle Cloud's free tier (or any Ubuntu server), [deploy/ORACLE.md](deploy/ORACLE.md)
walks through the whole setup, and `deploy/install-ubuntu.sh` does the
server's part of what follows.

### What you need

- A machine with public IPv4 (and ideally IPv6) addresses, and Node.js
  24.16 or later (the version Kin's server needs). No `npm install`: there
  are no dependencies.
- Ports **443/tcp**, **80/tcp** and **53/udp+tcp** open to the internet.
- A **zone** for home servers' free names, delegated to the relay (for
  example `home.kin.example.org`), and a **name for the relay itself**,
  outside that zone or inside it, with a certificate.

### 1. Delegate the zone

At the parent zone's DNS provider, delegate the relay's zone to the relay:

```text
home.kin.example.org.      NS    ns1.home.kin.example.org.
home.kin.example.org.      NS    ns2.home.kin.example.org.
ns1.home.kin.example.org.  A     203.0.113.10     ; glue: the relay's address
ns2.home.kin.example.org.  A     203.0.113.10
```

Two NS names pointing at one relay are fine to start with; a second relay
host later gives real redundancy. The relay answers `ns1.` and `ns2.` (or
the names in `KIN_RELAY_NAME_SERVERS`) with its own addresses.

The relay serves `CAA 0 issue ";"` at the zone's top, so names nobody has
claimed can't get a certificate. Don't add records for the zone anywhere
else.

### 2. Get the relay's own certificate

The relay needs an ordinary certificate for its own name (not for the zone).
Because the relay holds ports 80 and 443, use a DNS-01 challenge at the
DNS provider of the relay's name (with any ACME client), or stop the relay
for a moment and use a standalone HTTP-01 client. After each renewal send
the relay `SIGHUP` (for example a certbot `--deploy-hook "systemctl kill -s
HUP kin-relay"`); it reloads the files without dropping tunnels.

### 3. Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `KIN_RELAY_ZONE` | required | The zone for free names, e.g. `home.kin.example.org` |
| `KIN_RELAY_NAME` | required | The relay's own name, where tunnels connect |
| `KIN_RELAY_TLS_CERT`, `KIN_RELAY_TLS_KEY` | required | Paths to the relay's own certificate chain and key (PEM) |
| `KIN_RELAY_ADDRESSES` | required | The relay's public IPv4 and IPv6 addresses, comma-separated; DNS answers with them |
| `KIN_RELAY_DATA_DIR` | `/var/lib/kin-relay` | Where `registry.sqlite` lives; created mode 0700 |
| `KIN_RELAY_HOST` | `::` | The address to listen on |
| `KIN_RELAY_TLS_PORT`, `KIN_RELAY_HTTP_PORT`, `KIN_RELAY_DNS_PORT` | 443, 80, 53 | Ports; `off` turns port 80 or 53 off |
| `KIN_RELAY_NAME_SERVERS` | `ns1.<zone>,ns2.<zone>` | The zone's NS names |
| `KIN_RELAY_HOSTMASTER` | `hostmaster.<zone>` | The SOA contact, as a domain name |
| `KIN_RELAY_ABUSE` | `abuse@<zone>` | The abuse address on the status page; make sure it is read. Set it to a mailbox outside the zone: the relay serves no mail records, so the default can't receive mail |
| `KIN_RELAY_RESERVED` | | More reserved names, comma-separated (the built-in list is in `registry.mjs`) |
| `KIN_RELAY_NEW_NAMES_PER_WEEK` | 20 | The cap on new free names across the relay while the zone's Public Suffix List entry isn't used by Let's Encrypt; `0` for no cap |
| `KIN_RELAY_CT_URL` | `https://crt.sh/` | The Certificate Transparency search used once a day to free names that never got a certificate within 7 days; `off` never frees one |
| `KIN_RELAY_CONNECTIONS_PER_NAME` | 256 | Open phone connections per name |
| `KIN_RELAY_MBIT_PER_NAME` | 20 | Sustained bandwidth per name and direction, in Mbit/s |
| `KIN_RELAY_GB_PER_30_DAYS` | 50 | Bytes per name over 30 days, in GB; above it new connections are refused |

Other limits keep the ADR's defaults (`limits.mjs`): 60 new connections a
minute per client address per name, 15 minutes idle for a phone connection,
30 tunnel sign-ins an hour per source address, 3 name claims a day and 10 in
30 days per source address, one tunnel per home key (a newer one replaces
the older).

### 4. Run it as a service

A systemd unit. The relay runs as its own user under Node's permission
model, which lets it read only its code and its certificate and write only
its data directory:

```ini
# /etc/systemd/system/kin-relay.service
[Unit]
Description=Kin connection relay
After=network-online.target
Wants=network-online.target

[Service]
User=kin-relay
Group=kin-relay
EnvironmentFile=/etc/kin-relay/relay.env
ExecStart=/usr/bin/node --permission \
  --allow-fs-read=/opt/kin/relay \
  --allow-fs-read=/etc/letsencrypt \
  --allow-fs-read=/var/lib/kin-relay --allow-fs-write=/var/lib/kin-relay \
  /opt/kin/relay/start.mjs
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
StateDirectory=kin-relay
StateDirectoryMode=0700
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6
LimitNOFILE=200000
# The relay keeps no logs about connections; journald gets only its startup
# line and certificate reloads.

[Install]
WantedBy=multi-user.target
```

Copy only `relay/` to `/opt/kin/relay` (it needs nothing else from the
repository), make the `kin-relay` user able to read the certificate files,
then `systemctl enable --now kin-relay`.

### 5. Check it

```sh
dig @203.0.113.10 home.kin.example.org SOA          # the zone answers
dig @203.0.113.10 home.kin.example.org CAA          # 0 issue ";"
curl -sI http://anything.home.kin.example.org/      # 301 to https://
curl -s https://relay.kin.example.org/              # the status line
```

A home server's control panel then shows "connected" once it has signed in.

### Back up the registry

`registry.sqlite` holds which key owns which name and every retired name.
**Losing it would let names be claimed again by someone else**, which ADR
0025 §3 forbids, because browsers' stored data and passkeys belong to the
name. Back it up daily (stop the relay or use `sqlite3 registry.sqlite
".backup /backups/registry-$(date +%F).sqlite"`), keep the backups as
private as the relay, and restore the newest one before starting a
replacement relay.

## ECH (Encrypted Client Hello)

With ECH a browser encrypts the real server name and shows only a public
name from the site's ECH configuration, so an SNI router can't route it.
Browsers send real ECH only when the name's DNS publishes an ECH
configuration (an `ech` parameter in an HTTPS record). Therefore:

- **The relay's DNS publishes no HTTPS records** (it answers HTTPS queries
  with no data). This is a requirement on any relay: don't serve the zone
  from somewhere that adds them.
- **Own domains must publish none either.** The home server's control panel
  checks a household's own domain and refuses one whose HTTPS record has an
  `ech` parameter (some DNS providers add one automatically).
- **GREASE ECH** (a fake ECH extension browsers send anyway) carries the real
  name as its visible SNI, and the relay never reads the ECH extension, so
  it routes normally.
- If a **real** ECH hello arrives anyway, its visible name is the ECH
  configuration's public name, which the relay doesn't route: it answers
  with a TLS `unrecognized_name` alert and closes, as for any name it
  doesn't route.

## Abuse

The relay can't see inside connections, by design. When a report comes in,
look at the name's public pages like anyone else, and if it must stop:

```sh
KIN_RELAY_ZONE=home.kin.example.org node /opt/kin/relay/admin.mjs suspend smith.home.kin.example.org
```

Within a minute the relay closes that home server's tunnel with GOAWAY
code 5 and stops answering DNS for the name; it refuses the key's sign-ins
while suspended. `unsuspend` lifts it. Suspension never moves a name to
another key. `admin.mjs status <name>` shows the registry's row and 30
days' bytes; `admin.mjs errors` shows error counts.

## Test mode

```sh
node relay/start.mjs --test
```

Starts on loopback with the test certificate in `test-fixtures/` (for
`relay.home.test`; it is not a real certificate and its key is public), the
zone `home.test`, ports 8443, 8080 and 8053 (the `KIN_RELAY_*_PORT` settings
change them) and an in-memory registry. It is for development and tests
only; never for real households.

## Tests

`npm run verify` runs `relay/*.test.mjs` with the rest of Kin's Node tests;
`node --test relay/` runs just these. They cover the SNI parser (byte-built
browser hellos, hellos captured from Node's TLS client, every refusal, and a
fuzz run of 25,000 mutated inputs), the KTUN codec against TEST-VECTORS
186–193, the registry's rules, the in-memory limits, DNS answers, and the
relay end to end on loopback: a fake home server (`test-support/fake-home.mjs`)
signs in, a phone opens TLS to the relay for `x.home.test`, and the
handshake completes with the home server's own self-signed certificate.
