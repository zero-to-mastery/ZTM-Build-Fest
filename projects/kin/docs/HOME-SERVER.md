# Kin at home: building, running and installing the home server

A household can run Kin on its own computer (a PC, a Mac, a Raspberry Pi or
a NAS) instead of the hosted service ([ADR 0025](decisions/0025-kin-at-home.md),
epic #708). This page is for the person who builds or runs that **home
server**. A plain guide for households comes with #740.

## What is built so far

| Part | State |
| --- | --- |
| `KIN_MODE=home` (§9) | Built (#713). |
| One executable for Linux x64 and arm64 (Raspberry Pi) (§10) | Built (#714): `scripts/build-sea.mjs`. |
| One executable for macOS arm64 and x64 | Built (#747): Kin's Mach-O injector and ad-hoc signature. Device check under #717. |
| One executable for Windows x64 | Built (#748): Kin's PE injector. Device check under #717. |
| Container image for NAS and server users | Built (#715): `deploy/home/Dockerfile`. |
| Running as a service: systemd, launchd, Windows | Built (#716). On Windows a real service run by Kin's Rust service host, `kin-service-host.exe` (#749); a scheduled task when the host is missing. |
| Device checks on each platform | #717. |
| Control panel: first-run setup page and status page (§10, §11) | Built (#719, #720): [below](#setting-it-up-the-control-panel). |
| Certificates (ACME, §5) | Built (#723), started by home mode (#733): [HOME-CERTIFICATES](HOME-CERTIFICATES.md). |
| The tunnel to the connection relay (§2) | Built (#733): [below](#reaching-it-from-anywhere-the-tunnel). |
| Scheduled backups and restore (§10) | Built (#721): [below](#backups-and-restore). The copy to a second folder, such as a USB drive: built (#763), [below](#copies-to-another-folder). |
| Signed updates (§10) | Built (#722): [below](#updates). Off until the project's release key is made and built in. |
| Moving a household here from another Kin server ([ADR 0026](decisions/0026-moving-a-household.md)) | Built (#737, #738, #739, #769): [below](#moving-a-household-here). |

With a name set (below), phones reach the home server through the
connection relay. The setup page on the computer itself chooses the name and
records the agreement to the CA's terms; a technical household can still set
them by hand, in the home settings file or the environment.
A technical household can still put it behind `tailscale serve` or its own
TLS proxy instead, with `KIN_ORIGIN` set to that name and no home name
(README, "Running behind a TLS proxy"; ADR 0025, "Alternatives considered").

## Home mode

`KIN_MODE` is `hosted` (the default for `node server/start.mjs`, the
hosted service's behaviour) or `home`. The executable and the container
image run in home mode unless `KIN_MODE` says otherwise. Home mode changes
only this (`server/mode.mjs`):

- **One household.** `KIN_MAX_HOUSEHOLDS` defaults to 1, so creating a
  household closes once the owner's exists. The control panel raises it to a
  few more (up to 10, for grandparents' own household, say), with a fresh
  confirmation, and keeps it as `maxHouseholds` in the home settings;
  `KIN_MAX_HOUSEHOLDS`, when set, wins and the panel shows it without
  offering a change. `KIN_ALLOW_NEW_HOUSEHOLDS=false` still closes creation.
  Invitations into an existing household are never affected.
- **No Google Play settings.** `KIN_ANDROID_PACKAGE` and
  `KIN_ANDROID_CERT_SHA256` stop startup with an explanation: the Play app is
  bound to `kin.journeytocode.io` ([ADR 0020](decisions/0020-google-play-twa.md)).
- **System data folder.** Without `KIN_DATA_DIR`, data lives in the
  platform's system location instead of `.kin-data` in the app:

  | Platform | Data directory |
  | --- | --- |
  | Linux | `/var/lib/kin` |
  | macOS | `/Library/Application Support/Kin` |
  | Windows | `%ProgramData%\Kin` |
  | Container | `/data` (set by the image) |

Everything else is the same as hosted: the sandbox, the database, every
format, push, calendar sync. `KIN_FEEDBACK_GITHUB_*` still works and is off
unless set; reports stay on the home server for its admins.

## Reaching it from anywhere: the tunnel

ADR 0025 §1–§2 and §5; `server/home/`. In home mode with a **name** set,
the service:

1. makes its **home key** on first run: an Ed25519 key in
   `<data>/home/home-key.pem` (mode 0600, in the 0700 `home/` folder, next
   to the certificate files). The name is bound to it for good: back it up
   with the rest of `home/`, and keep the backup as private as the computer.
2. dials the **connection relay** on port 443 (TLS 1.3, ALPN
   `kin-tunnel/1`, the relay's certificate checked the normal way), and
   signs in with the home key over a value exported from that TLS session,
   so the signature works on that connection only.
3. **claims its free name** (a name directly under the zone), or asks the
   relay to route **its own domain** (which needs the `_kin-relay` TXT
   record, ADR 0025 §3).
4. starts the **certificate manager**
   ([HOME-CERTIFICATES](HOME-CERTIFICATES.md)): before the first order it
   sets the free name's CAA record at the relay to its ACME account
   (`SET_CAA`), then answers the CA's TLS-ALPN-01 check, which travels
   through the relay like any phone.
5. ends TLS for each phone connection itself and hands the decrypted
   connection to the same HTTP server as the loopback listener, so every
   page, API route and the live channel work as they do on the hosted
   service. The relay forwards bytes it can't read.

It opens no listener beyond loopback. The origin becomes `https://<name>`
(an explicit `KIN_ORIGIN` must be that same origin). Without a name, home
mode serves only the setup page on loopback, logs `home_not_configured` and
prints a setup code ([below](#setting-it-up-the-control-panel)).

### Settings

They live in `<data>/home/settings.json`, which the setup page and the
control panel write (mode 0600, replaced atomically, checked before
anything is written), and each can be overridden from the environment:

| Setting | Variable | Default |
| --- | --- | --- |
| `name` | `KIN_HOME_NAME` | none: the tunnel stays off |
| `relay` | `KIN_HOME_RELAY` | `relay.kin.journeytocode.io` (port 443; `host:port` for another) |
| `zone` | `KIN_HOME_ZONE` | `home.kin.journeytocode.io` |
| `acmeDirectory` | `KIN_HOME_ACME_DIRECTORY` | Let's Encrypt production (must be `https://`) |
| `acmeTermsAgreed` | `KIN_HOME_ACME_TERMS_AGREED` | `false`: no certificate until the admin agrees to the CA's terms |
| `maxHouseholds` | (`KIN_MAX_HOUSEHOLDS` wins when set) | none: home mode's 1 |

```json
{ "format": 1, "name": "fern.home.kin.journeytocode.io", "acmeTermsAgreed": true }
```

A setting that can't be read stops startup with `home_settings_invalid`
and says which one. A damaged home key stops it with `home_key_invalid`:
it is never replaced silently, because a new key can't take over the name.

### Staying connected

- After a lost tunnel it waits a random time between 0 and the current
  backoff (1 second, doubling to 5 minutes), and the backoff starts again
  once a tunnel has stayed up a minute. Refused sign-ins, a suspended name,
  and a tunnel taken over by another copy of the same key (a restored
  backup running elsewhere) wait the full 5 minutes.
- It reconnects at once when the computer's network addresses change
  (checked every 5 seconds) or the clock jumps by more than two ping
  intervals (it slept). The new tunnel replaces the old one at the relay.
- It pings after 25 seconds of silence and gives up on a tunnel silent for
  75 (the relay's values).
- Each phone connection has credit windows both ways (256 KiB per
  connection, 4 MiB per tunnel by default): a phone that stops reading
  stops Kin's response at its source, and nothing piles up in the tunnel
  or the relay.

`status()` (on the running server's `home` object) is what the control
panel's status page shows; it holds no address or key:

```text
tunnel: { state: "connected" | "connecting" | "waiting" | "stopped", connected,
          relay, name, names, routed, nameError: { code, at } | null,
          lastError: { code, at } | null, since, nextAttemptAt, streams }
certificate: CertificateManager.status() (HOME-CERTIFICATES)
```

Error codes: `relay-unreachable`, `relay-certificate`, `relay-tls`,
`sign-in-timeout`, `auth-failed`, `replaced`, `limit`, `suspended`,
`relay-overloaded`, `relay-shutting-down`, `protocol-error`,
`tunnel-dead`, `connection-lost`; for the name `name-taken`,
`name-not-allowed`, `name-limit`, `name-unknown`. The log has one JSON line
per change (`home_tunnel_connected`, `home_tunnel_lost` with its code,
`home_tunnel_reconnect` with `wake`, `network-change` or `relay-draining`,
`home_tunnel_caa_set`, `home_certificate_*`), never an address.

### Client addresses and rate limits

Each phone connection's address comes from the relay, in the stream's
`OPEN` frame, outside anything the phone sends. Rate limits key on it per
IPv4 address or IPv6 /64, and `X-Forwarded-For` is ignored on tunnel
connections, whatever `KIN_TRUSTED_PROXIES` says. Connections on the
loopback listener keep the usual rules.

### Not built: direct access on the home network

ADR 0025 §4 defers it: a phone at home goes out to the relay and back. A
household with its own DNS can still point its own domain at the home
server and run its own TLS proxy, as `deploy/` shows.

## Setting it up: the control panel

ADR 0025 §10–§11; `server/home/control-panel.mjs`, `server/home/setup.mjs`
and the pages in `web/control/`. The control panel is the home server's own
pages: no separate app, no terminal needed after the first start.

### First run

1. **Start Kin** (the executable, `node server/start.mjs` with
   `KIN_MODE=home`, or the service). With no name yet it listens on
   loopback only, keeps the app's API closed (`home_setup_required`, so no
   household is made on `localhost`, where its passkeys would belong to the
   wrong name) and prints a **setup code**:

   ```text
   Set up Kin: open http://localhost:8000/control/ on this computer and enter the setup code ABCDE-23456. It works once, until 14:05.
   ```

   The service logs it as a `home_control_code` JSON line; the launcher shows
   it in plain words and, started in a terminal (not as a service), opens the
   browser at that address. `KIN_OPEN_BROWSER=0` stops that. On a computer
   without a screen, open the address from a browser on the same computer,
   or read the code from the log (`journalctl -u kin` or the log file).

   **In the container** "this computer" is the container itself: its
   loopback can't be reached from the host's browser, and the loopback
   panel refuses anything else. Set the name and the agreement in the
   environment instead (`KIN_HOME_NAME`, `KIN_HOME_ACME_TERMS_AGREED=true`;
   [Settings](#settings)), then use the control panel at
   `https://<name>/control/` as a household admin.
2. **Enter the code.** It is 10 letters and digits without look-alikes, works
   once, for an hour, and five wrong tries destroy it. "Print a new code"
   prints another (at most one every 30 seconds). The browser then keeps a
   control session for 30 days (an HttpOnly cookie for `/control` only),
   stored on the server as a hash in `home/control-sessions.json`.
3. **Choose the name.** A free name (`<word>.home.kin.journeytocode.io`) or
   the household's own domain. The page checks the name with the relay as
   you type (`CONTROL` op 7 `CHECK`, which claims nothing): available, taken,
   not allowed, or "this server already has a name". Choose it once:
   passkeys, the installed app and every device's saved data belong to it.
4. **Agree to Let's Encrypt's terms**, linked from the CA's own directory.
   Until then no ACME account exists and no certificate is ordered. For an own
   domain the ACME account is made at this step, because its CAA record names
   the account.
5. **Own domain only: the DNS records.** The page shows the exact records,
   each with a copy button, and checks them before going on:

   | Record | Value |
   | --- | --- |
   | `<domain>` A / AAAA | the relay's addresses (not a CNAME: CAA lookups follow a CNAME back to the relay's zone) |
   | `_kin-relay.<domain>` TXT | the base64url SHA-256 of this server's home key |
   | `<domain>` CAA | `0 issue "letsencrypt.org; accounturi=<this server's account>; validationmethods=tls-alpn-01"` and `0 issuewild ";"` |
   | `<domain>` HTTPS | none with an `ech` parameter (some DNS providers add one; the relay can't route Encrypted Client Hello) |

   It also asks the relay whether it sees the TXT record, since the relay
   routes the domain only after it does. Another CAA `issue` entry, a
   CNAME, or an address that isn't the relay's is reported in plain words.
6. **Connect.** Kin writes `home/settings.json` (the name and the terms
   agreement, mode 0600) and **restarts once**: it exits with code 75, which
   the launcher reads as "start me again now" (with or without
   `--supervise`). Started directly (`node server/server.mjs`), it just
   stops; start it again. It comes back as `https://<name>`, connects to the
   relay, claims the name, sets CAA and gets its certificate. The page waits
   through the restart and shows each part as it happens; a certificate error
   is explained, with "Try again now".
7. **Open Kin** at `https://<name>` and create the household there, with
   Kin's normal first run, on the phone or computer you'll use most. The page
   becomes the status page.

If the relay refuses the name at the claim (taken since the check), the page
goes back to step 3. Once a certificate exists the name can't be changed
here: that is a move to a new address (ADR 0025 §12). With `KIN_HOME_NAME`
set, the page shows progress but doesn't offer the name.

### Reaching the control panel later

- **On this computer:** `http://localhost:<port>/control/` (the root address
  leads there too). A browser with a control session opens it at once;
  otherwise "Print a new code" prints an access code to Kin's window and
  log.
- **From anywhere:** `https://<name>/control/`, for a signed-in **household
  admin** of a household on this server. Anyone else is told to sign in, or
  that it is for admins.

**Every change needs a fresh confirmation.** Through the household's address
it is the admin's passkey, or their password for an admin without one, as
Kin's other admin changes. On this computer the panel asks Kin to print a
**confirmation code** (valid 10 minutes, once, five tries) in its window and
log. Setup itself (steps 3–6) is confirmed by the setup code, before there
is anything to protect: no name, no certificate, no household.

### The origin: why the panel has its own API on loopback

A set-up home server's app origin is `https://<name>`, and the app's API
refuses any other `Origin`; the browser on the computer itself is at
`http://localhost:<port>`. Rather than give the app a second origin (which
would weaken `assertSecureOrigin`, WebAuthn's relying party and the API's
cross-site check), the loopback panel has its own small API,
`/control/api/*`, which the app's API never serves. It answers only:

- connections from the loopback listener, never a tunnel stream (whatever
  its `Host` header says);
- a loopback peer, with a `Host` of `localhost`, `127.x.x.x` or `[::1]` and
  the listener's own port, so a page on another name that resolves to
  127.0.0.1 (DNS rebinding) is refused;
- requests without `X-Forwarded-For`, `Forwarded` or `X-Real-IP`; with
  `KIN_TRUSTED_PROXIES` set the loopback panel is off altogether, because a
  proxy in front makes "loopback" mean anyone;
- for changes, an `Origin` of exactly `http://<that Host>`, a JSON body, and
  `Sec-Fetch-Site: same-origin` when the browser sends it.

Through the household's address the panel uses the app's own API
(`/api/control/status`, `/api/control/change/options` and `/finish`),
behind the app's origin check and session like every other route.

### The status page

It shows, in plain words, with every state and error code explained:

- **Connection:** connected to the relay or not, since when, the next try,
  and why (for example `replaced`: another computer runs this home server's
  key, a restored backup; `name-taken`; `relay-certificate`: check the
  clock).
- **Name:** the address, free or own domain, and whether the relay routes it.
- **Certificate:** valid until, next renewal, the issuer, the last error
  (`acme-*`, or `tunnel-caa-*` when the relay didn't set the CAA record) and
  the daily certificate-log (CT) check.
- **Backups:** the last and next backup, the daily time, how many are kept
  and their size, the last failure (`backup-*`), the last restore and the
  second copy, if one is set up (`backup-copy-*`;
  [below](#backups-and-restore)).
- **Storage:** the database's size and the disk's free space.
- **Households and devices:** counts only. The status holds no household
  content, no identifier of a household, member or device, no device label,
  no key and no address.
- **Version and updates:** the version, when Kin last checked, an update
  that is available and how it installs, and how the last update went
  ([below](#updates)).
- **Settings:** new households allowed (1–10); back up now, the daily
  backup time, the folder backups are copied to (on this computer only)
  and restore a backup; install an update now, and automatic updates on or
  off.

`panel.provide(section, () => object)` fills a status section,
`panel.registerChange(kind, { check, apply, loopbackOnly })` adds a change
that both ways in confirm the same way (a `loopbackOnly` change only on the
home server's own computer), and `SECTIONS` and `SETTINGS` in
`web/control/` render them. Backups (#721, #763) and updates (#722) use
these seams.

### Backups and restore

Kin backs the home server up by itself, every day at 03:00 on the
computer's clock (the control panel changes the hour; it is `backupHour` in
`home/settings.json`). A computer that was off or asleep then backs up
within a few minutes of starting. The first backup is made a few minutes
after setup. Kin keeps the **14** newest in the `backups` folder of its data
folder, and never touches other files there.

Each backup is a folder, `backups/kin-<date>T<time>Z/`, holding:

- `kin.sqlite`: the database, copied with SQLite's `VACUUM INTO` while Kin
  runs, then opened and checked as Kin checks its database at startup
  (the same verified copy as `kin admin backup`);
- `home/`: the home key, the ACME account key, the certificate and the home
  settings, so the backup is the whole home server and its name. The control
  panel's sessions stay behind;
- `backup.json`: when, why (daily or by hand), Kin's version and the size,
  written last, so a folder without it is unfinished and Kin removes it.

**A backup is as sensitive as the computer.** With the home key in it,
whoever has a copy can connect to the relay as this home server and get a
certificate for its name (ADR 0025 §7). The database in it is encrypted
household content and metadata, as on the server itself (SELF-HOSTING,
"Back up and restore").

**Restoring** is a change in the control panel, confirmed like any other
(the printed code here, the admin's passkey or password through the
household's address). Kin first checks that the backup opens, then stops and
starts again (the launcher restarts it), and restores before it opens its
database, with the same restore as `kin admin restore`:

- it keeps the database it replaces as `kin.sqlite.pre-restore-…`;
- households deleted since the backup stay deleted, and current members,
  devices and keys are kept, so a restore never brings back revoked access;
- it refuses a backup older than a household that is on the server now, and
  one taken while a household is being deleted;
- anything added since the backup is still on the phones and computers that
  added it, which send it again when they next connect.

If the restore is refused or fails, Kin starts with the data it had and the
status page says why.

**Moving to a new computer.** Copy a backup folder into the new computer's
`backups` folder (for example `/var/lib/kin/backups/` or
`C:\ProgramData\Kin\backups\`), start Kin there, and open the setup page:
before you choose a name it offers *Moving from another computer?* Restoring
there brings the home folder too, so the new computer is the same home
server, with the same name, and setup is already done. Stop Kin on the old
computer first: only one copy of a home server can be connected at a time
(`replaced` on the status page). On a computer that is already set up, a
restore puts back the database only and keeps this computer's home folder.

The schedule runs inside the service, and the backups stay inside its data
folder, which is all the service may write (the permission model). The copy
to another folder, below, is made by the launcher, which runs outside that
sandbox.

#### Copies to another folder

A backup on the same disk as Kin is lost with that disk. Kin can copy each
backup to a second folder too, such as a USB drive. Choose it in the
control panel's settings, *Copy backups to another folder*, by its full
path (`E:\` on Windows, `/media/usb` on Linux, `/Volumes/KIN` on a Mac).
Leave it empty to stop copying; copies already there stay.

- **Only on the home server's own computer.** The copies hold every
  household's data and the home key, so the folder can't be chosen through
  the household's address, and only this computer's panel shows its path.
  Keep the drive as private as the computer.
- **What goes there:** `<your folder>/Kin backups/<this server's name>/`,
  holding the same `kin-<date>T<time>Z/` folders as `backups/`. Kin keeps
  the 14 newest there too and never touches anything else on the drive,
  another home server's folder included. A server whose name changed starts
  a new folder and leaves the old one.
- **When:** within a minute of each backup, when Kin starts, and within a
  minute of plugging the drive in, including another drive plugged in at
  the same place, which gets every backup. An unplugged drive shows on the
  status page within a minute. Each copy's database is read back and
  checked against the backup, which catches a copy that went wrong, though
  not a faulty drive that only pretends to keep what it's given. Its
  `backup.json` is written last and flushed to the drive, so a copy cut
  short (the drive pulled out) has no `backup.json`, isn't used, and is
  made again once the drive is back. A folder changed or emptied in the
  panel during a copy gets nothing more.
- **What Kin refuses:** Kin never makes the folder you chose. If it isn't
  there (the drive isn't plugged in) the status page says so, and Kin copies
  once it is. A folder on the same partition as Kin's data is refused, since
  it wouldn't survive that disk. Kin can't tell another partition of the
  same disk apart (`D:\` beside `C:\` on one drive), so choose a separate
  drive. On Linux and macOS, a folder under `/media`, `/mnt`, `/run/media` or
  `/Volumes` with no drive mounted there is reported as missing too, so an
  unplugged drive's empty mount point is never filled: the drive must be
  mounted at the folder you chose or one above it, such as `/Volumes/USB`
  or `/media/<you>/<label>`. A drive mounted at `/mnt` or `/media` itself is
  fine. A full drive is
  reported, never cleared to make room. FAT32 holds no file over 4 GB, so
  use exFAT or NTFS for a large Kin.
- **Restoring from a copy:** copy a `kin-…` folder from the drive into Kin's
  `backups` folder, then restore it in the panel, as when moving to a new
  computer (above).

On each system:

- **Linux:** mount the drive under `/media`, `/mnt` or `/run/media`; Kin's
  service may write only there (and not under `/home`). A Kin installed
  before this version needs `sudo kin --install-service` again to allow it.
  A desktop's automatic mount (`/media/<you>/<label>`) may not let the `kin`
  account in; a line in `/etc/fstab` mounting the drive under `/mnt`, owned
  by `kin`, always works.
- **Windows:** use a drive letter on this computer, not a mapped network
  drive, which the service's account (LOCAL SERVICE) can't see. On an NTFS
  drive, give LOCAL SERVICE permission to write the folder. Kin then lets
  only LOCAL SERVICE, the account Kin runs as, SYSTEM and Administrators
  into the `Kin backups` folder for this server, as with its data folder.
  A FAT32 or exFAT drive can't keep anyone out: every account on any
  computer it is plugged into can read the copies, so keep that drive
  locked away. If Kin can't make the copies private (such a drive, or a
  folder you made or copied there whose permissions Kin isn't allowed to
  change), it still copies, the status page says so, and Kin tries again
  with the next backup; giving LOCAL SERVICE full control of the folder
  fixes the second case.
- **macOS:** drives appear under `/Volumes`. If the status page says Kin
  isn't allowed to write there, allow it in System Settings, Privacy &
  Security.
- **Container:** mount the drive's folder into the container as a volume
  separate from `/data`, and choose that path.

## Moving a household here

A household on the hosted service (or another Kin server) can move here and
keep everything: accounts, members, devices' history, chat, the fridge,
private spaces and attachments ([ADR 0026](decisions/0026-moving-a-household.md)).
The old server sends this one the household's records directly; no file of
them is ever handed to anyone.

1. Here, on the home server's own computer, open the control panel and
   choose **Get a move code** (under *Moving a household here*). Kin prints
   a one-time move code in its window and log, like its other codes: it
   works once, for an hour, with five tries. The server must be set up (its
   name and certificate) and have room under its household limit.
2. On the old address, a household admin opens *Household › Household
   access › Move to a home server*, checks who can sign in at the new address
   (a password or a backup code; anyone with only a passkey is asked to save
   a backup code first, or re-joins by invitation), and enters this server's
   address and the code, confirming with their passkey or password.
   Everyone's app on the old address then says where the household went.
3. The old server sends the household here in 8 MiB pieces (it can resume
   after a dropped connection), at most 4 GB. Kin checks the whole package
   (size and SHA-256), then opens it as a Kin database, which runs the same
   checks as at startup and refuses one from a newer Kin ("update this home
   server first"), and refuses it if this server already has that household,
   one of its members or devices, or one of its usernames. It adds the
   household in one transaction, so a failure changes nothing, and restarts.
4. People open this server's address and sign in with the same username and
   password, or their backup code. Their device downloads the whole
   history, then Kin offers a new passkey: passkeys belong to the old
   address.
5. The household's old devices arrive too, so its history still checks
   out, but they can't sign in here: *People & devices* shows them as
   *From the old address*. Once everyone has signed in here, a household
   admin removes them together with **Remove the N devices from the old
   address** and a fresh passkey or password. Anyone who hasn't signed in
   yet still can, with their password or backup code, or with a recovery
   invitation from an admin if they have neither.

What arrives has no device tokens and no passkeys, so nothing is signed in
here until people sign in. The control panel shows when a household last
moved here.

The receiving end is `/api/move/*` on this server's address
(`server/home/move-receive.mjs`): `start` with the move code opens one
transfer and returns a bearer token for it (two hours); `chunk`, `status`,
`finish` and `DELETE /api/move` use that token. The package format is in
`server/move-package.mjs`.

## Building the executables

```sh
# from projects/kin, with Node 24.22.0 (the version the executables run on)
./build-wasm.sh                      # or: node scripts/fetch-wasm.mjs
node scripts/build-sea.mjs           # all five targets
node scripts/build-sea.mjs --target darwin-arm64,darwin-x64
node scripts/build-sea.mjs --target win-x64
node scripts/build-sea.mjs --target linux-x64 --measure
```

Every target builds on any machine: a Linux computer builds the Mac and
Windows executables, and the other way round. The Windows build also ships
the service host beside `kin.exe` (below, "Building the host"): on a
machine that can't build it, give one built on Windows in
`KIN_SERVICE_HOST_EXE`. The script downloads the official node binary for each target from
nodejs.org, checks it against the release's `SHASUMS256.txt`, and caches it
in `target/sea/node/`. `--node-binary PATH` uses a binary you already have
(for one target), and `--node-version X.Y.Z` picks another release (the
build then needs that version of node on this machine to write the blob).
The results are in `target/sea/dist/`:

- `kin-<version>-linux-x64`, `kin-<version>-linux-arm64`,
  `kin-<version>-darwin-arm64`, `kin-<version>-darwin-x64` and
  `kin-<version>-win-x64.exe`, 95 to 135 MB each (node itself is most of
  it);
- `kin-service-host-<version>-win-x64.exe`, the Windows service host
  (#749), which belongs in the same folder as the Windows executable;
- `SHA256SUMS`, to check with `sha256sum -c SHA256SUMS`;
- `build-info.json`: the version, node release, the hash of every bundled
  file, and the hash of each node binary used;
- with `--measure`, `start-time.json`: the size, and the time from starting
  the executable for this machine to the service being ready, the first time
  (it unpacks its files) and after. On a development machine it was about
  330 ms and 300 ms.

Before writing each executable the script parses it back with the same
reader the injector uses and checks it (`checkExecutable`): the blob is
where Node looks for it and byte-identical, the fuse is flipped, and the
layout is one the system's loader accepts (below). On a Mac it also runs
`codesign --verify --strict` on the macOS executables.

The CI job `home-executables` builds all five targets on Linux for every
change, starts the Linux x64 one, runs the injector tests against the
official node binaries it downloaded, and keeps the results as the
`kin-home-executables` artifact. `home-executables-run` then takes the Mac
(arm64) and Windows executables to a Mac and a Windows runner: `codesign
--verify` must accept the macOS signatures, each executable must print its
version, start and answer `--health`, and the same target built natively
there must be byte-identical to the Linux build.

**Reproducible.** The same sources, engine and node binary give
byte-identical executables: files are bundled in sorted order, the blob has no
code cache or snapshot, and the injector is deterministic
(`scripts/build-sea.test.mjs` builds twice and compares). That holds across
build machines too: node writes the blob's assets in an order that depends
on the C++ library it was built with (different on Linux, macOS and
Windows), so the build rewrites them sorted by name (`scripts/sea/blob.mjs`),
and `.gitattributes` keeps the bundled files' LF line endings in a Windows
checkout. CI compares the Mac and Windows executables built natively with
the Linux build's. A code cache would make the blob machine-specific and
gains nothing measurable: it only covers the small main script, and the
server's modules load from disk (first start 335–494 ms without, 420–561
ms with; later starts about 300 ms either way, on Linux x64).

**How it works.** The executable is a Node
[single executable application](https://nodejs.org/api/single-executable-applications.html).
`node --experimental-sea-config` writes a blob with `scripts/sea/main.cjs` as
its main script and the server, the web app, `package.json` and the WASM
engine as assets. Node usually adds the blob with the `postject` npm
package; Kin can't use npm packages, so `scripts/sea/elf.mjs` writes it into
a copy of the node binary itself, with the sentinel fuse flipped
(`scripts/sea/fuse.mjs`), in the form Node looks for on each system:

- **Linux** (`scripts/sea/elf.mjs`): a `NODE_SEA_BLOB` note in a new
  read-only segment, with the program header table moved to the end of the
  file.
- **macOS** (`scripts/sea/macho.mjs`): a section `__NODE_SEA_BLOB` in a new
  read-only segment `NODE_SEA` (the names Node's `src/node_sea_bin.cc`
  passes to `getsectdata`), placed where `__LINKEDIT` was; `__LINKEDIT`
  moves up and stays last, every load command that points into it is
  moved, and its chained fixups get an entry for the new segment, as dyld
  requires. Node's own signature (Developer ID) no longer matches, so it is
  cut off and replaced by an **ad-hoc signature** written by
  `scripts/sea/codesign.mjs`: a CodeDirectory of SHA-256 hashes of every
  4 KiB page, empty requirements, no certificate, the same as
  `codesign --sign -` writes. Apple silicon won't run a binary without one.
  Its page hashes are computed exactly as Apple's are (a test compares them
  with node's own signature), and no Mac or `codesign` is needed to build.
  A universal binary is reduced to the target's slice first; nodejs.org
  ships thin ones.
- **Windows** (`scripts/sea/pe.mjs`): an `RT_RCDATA` resource named
  `NODE_SEA_BLOB` (what `FindResource` looks up), in a new `.rsrc` section
  at the end holding every resource node.exe had (icons, version
  information, manifest) plus the blob. The old resource section stays,
  unused, as `.rsrc0`; no other section moves. node.exe's Authenticode
  certificate table is removed (the injection invalidates it), and
  `SizeOfImage`, the data directories and the checksum are rewritten.

When it runs, the executable writes its app files once to a cache folder
(`app-<bundle hash>` inside `KIN_APP_CACHE`; by default systemd's
`CACHE_DIRECTORY`, else `~/.cache/kin`, `~/Library/Caches/Kin` or
`%LOCALAPPDATA%\Kin`), checks every file's SHA-256 on each start and
rewrites any that changed. That folder, by its real path (macOS's
temporary folders are symlinks, and the permission model compares paths as
written), is the service's read-only app directory. Copies started at the
same moment (the service and `kin --health`, say) unpack safely side by
side, also on Windows, where a folder in use can't be replaced. The launcher then starts a second copy of the executable as the
service, with Node's permission flags in `NODE_OPTIONS` (an executable takes
no Node flags on its command line), so the service runs in the same sandbox
as `node server/start.mjs`: it reads the app, reads and writes only its data
directory, and can't start processes.

## Running it

```sh
chmod +x kin-1.6.0-linux-x64
KIN_DATA_DIR=~/kin-data ./kin-1.6.0-linux-x64
```

On a Mac, `KIN_DATA_DIR=~/kin-data ./kin-1.6.0-darwin-arm64` (or
`-darwin-x64` on an Intel Mac; the first time, see "Unsigned builds"
below). On Windows, in PowerShell:
`$env:KIN_DATA_DIR = "$HOME\kin-data"; .\kin-1.6.0-win-x64.exe`.

Open `http://localhost:8000` on the same computer: the first time, it is the
setup page, with the code the program printed
([above](#setting-it-up-the-control-panel)). Without `KIN_DATA_DIR` it uses
the system data folder (`/var/lib/kin` on Linux), which an ordinary account
can't write: install it as a service instead (below), or set `KIN_DATA_DIR`. The other settings are the
server's usual ones (README): `KIN_PORT`, `KIN_ORIGIN`,
`KIN_TRUSTED_PROXIES` and so on.

```text
kin --help                 every command
kin --version
kin --health               0 if the running service answers /health (as KIN_HOST/KIN_PORT)
kin admin backup PATH      a verified backup of the database alone, as node server/admin.mjs backup
                           (the control panel's backups also hold home/; see above)
kin admin restore PATH --acknowledge-deletion-history
                           restore (stop Kin first; as node server/admin.mjs restore)
kin --print-service        print this computer's service definition
```

From a checkout, `node server/start.mjs` takes the same commands, and
`KIN_MODE=home node server/start.mjs` runs it in home mode.

## Installing it as a service

The service starts when the computer starts (no one needs to sign in),
restarts if it fails, and runs as an ordinary account, never as root or
Administrator. Install and uninstall need admin rights. **Uninstalling
removes the service and Kin's installed copy and keeps the data directory**;
delete that yourself only if you no longer need it. Use `--print-service`
to read what will be installed first.

### Linux (systemd)

```sh
sudo ./kin-1.6.0-linux-x64 --install-service
systemctl status kin
journalctl -u kin
sudo /usr/local/lib/kin/kin --uninstall-service
```

Installing creates a system account `kin`, copies the executable to
`/usr/local/lib/kin/kin` and writes `/etc/systemd/system/kin.service`:
`User=kin`, `StateDirectory=kin` (`/var/lib/kin`, mode 0700),
`CacheDirectory=kin` for the app files, `UMask=0077`,
`Restart=on-failure`, and hardening (`NoNewPrivileges`,
`ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `PrivateDevices`, no
capabilities; `MemoryDenyWriteExecute` stays off because V8 compiles code).
Change settings with `sudo systemctl edit kin` (for example
`Environment=KIN_PORT=8080`). Uninstalling keeps `/var/lib/kin` and the `kin`
account, so the files keep their owner.

### macOS (launchd)

```sh
sudo ./kin --install-service            # runs as the account that ran sudo
sudo ./kin --install-service --user kin # or as another account
sudo /usr/local/libexec/kin/kin --uninstall-service
```

Installing copies the executable to `/usr/local/libexec/kin/kin`, removes the
download's quarantine flag from that copy (launchd won't start a
quarantined unsigned program; you already chose to open it), creates
`/Library/Application Support/Kin`, `/Library/Caches/Kin` and
`/Library/Logs/Kin` owned by that account with mode 0700, and writes the
LaunchDaemon `/Library/LaunchDaemons/io.journeytocode.kin.plist` with
`UserName`, `RunAtLoad`, `KeepAlive` and `Umask` 077. Its log is
`/Library/Logs/Kin/kin.log`. The same commands work with
`node server/start.mjs` from a checkout.

### Windows (a service, with Kin's service host)

```powershell
# in a terminal opened with "Run as administrator"
.\kin.exe --install-service
sc.exe query Kin
.\kin.exe --uninstall-service
```

A program registered with `sc.exe` must answer the Service Control Manager
within seconds, which a Node program can't (Windows gives up with error
1053). So the service runs Kin's **service host**, `kin-service-host.exe`, a
small program written in Rust with only the standard library
(`tools/kin-service-host`, ADR 0025 §10, #749). It ships beside the Windows
executable; keep the two files in the same folder when you install.

Installing:

- stops an earlier Kin service or scheduled task, so files can be replaced;
- copies `kin.exe` and the host to `%ProgramFiles%\Kin\`;
- creates `%ProgramData%\Kin` (data) and `%ProgramData%\Kin-app` (app
  files) with access for LOCAL SERVICE, SYSTEM and Administrators only;
- registers the service `Kin` with `sc.exe create` (or `sc.exe config` when
  it exists): started automatically at boot, as the low-privilege
  **LOCAL SERVICE** account;
- sets its recovery with `sc.exe failure` (restart after 5 seconds, then 30,
  then every minute; the count resets after a day) and `sc.exe failureflag`
  (so a stop with an error counts too), and starts it.

The service's command line (`sc.exe qc Kin` shows it) is the host, its own
options, then `--` and the launcher's arguments:

```text
"C:\Program Files\Kin\kin-service-host.exe" --program "C:\Program Files\Kin\kin.exe"
  --working-directory C:\ProgramData\Kin --env KIN_DATA_DIR=C:\ProgramData\Kin
  --stop-timeout 40 --log-file C:\ProgramData\Kin\logs\service-host.log
  -- --stop-on-stdin-close --log-file C:\ProgramData\Kin\logs\kin.log
  --app-cache C:\ProgramData\Kin-app
```

`kin-service-host.exe --help` lists the options. The host:

- reports *start pending*, starts `kin.exe`, and reports *running*;
- starts `kin.exe` again if it exits on its own, after 1 second, doubling
  to a minute (back to 1 second after a minute up); Windows' own restart
  covers the host itself;
- on **stop**, **shutdown** or **preshutdown**, reports *stop pending* and
  **closes `kin.exe`'s stdin**. A service has no console, so Ctrl+C can't be
  sent, and ending a process gives it no chance to close its database. The
  launcher, started with `--stop-on-stdin-close`, passes the stop on to the
  service the same way, and the service closes its database (30 seconds at
  most) and exits. If the host itself dies, the pipe closes too.
- ends `kin.exe` if it is still running after `--stop-timeout` (40 seconds);
  the service process goes with it (Node keeps the processes it starts in a
  job that ends with it);
- reports *stopped* with Kin's exit code (0, or a service-specific error
  with the code; `sc.exe query Kin` shows it).

Logs: `%ProgramData%\Kin\logs\kin.log` for Kin (moved to `kin.log.1` past
10 MiB) and `service-host.log` beside it for the host, one JSON line per
event, plus anything `kin.exe` prints before its own log opens (moved to
`service-host.log.1` past 1 MiB). Uninstalling stops the service and waits
for it, deletes it with `sc.exe delete`, removes an old scheduled task and
`%ProgramFiles%\Kin`, and keeps `%ProgramData%\Kin`.

**Without the host** (a `kin.exe` downloaded on its own), installing falls
back to the ADR's alternative from #716 and says so: a scheduled task `\Kin`
that starts at boot as LOCAL SERVICE, with no time limit, and the launcher
restarting the service itself if it fails (`--supervise`). Stopping the task
ends the launcher, which closes the pipe the service watches, so it still
closes its database. Put `kin-service-host.exe` beside `kin.exe` and install
again to switch to the service; `KIN_SERVICE_HOST` can name a host elsewhere.

**Building the host.** `cargo build --release --manifest-path
tools/kin-service-host/Cargo.toml` on Windows (the `x86_64-pc-windows-msvc`
target the Rust installer sets up), or with `--target x86_64-pc-windows-gnu`
elsewhere (with mingw-w64). `scripts/build-sea.mjs` builds it with the
Windows executable and ships it beside it as
`kin-service-host-<version>-win-x64.exe` (listed in `SHA256SUMS`;
`KIN_SERVICE_HOST_EXE` gives a host built elsewhere), which
`--install-service` also finds. On Linux that needs the
`x86_64-pc-windows-gnu` Rust target and mingw-w64, or a host built on
Windows given in `KIN_SERVICE_HOST_EXE`: CI's `home-executables` job uses
the one the `service-host` job built on Windows. From a checkout,
`node server\start.mjs --install-service` installs the service with node
and the host from `tools\kin-service-host\target\release\`, or the task
without it.

## The container image

```sh
# from projects/kin
docker build -f deploy/home/Dockerfile -t kin-home .
docker run -d --name kin --restart unless-stopped -v kin-data:/data kin-home
docker inspect -f '{{.State.Health.Status}}' kin
docker exec kin /opt/kin/kin admin backup /data/backup.sqlite
```

The image holds the same executable as the downloads, built for the image's
architecture (x64 or arm64) from the official node in `node:24.22.0-slim`,
on `gcr.io/distroless/cc-debian12:nonroot`: glibc and the C++ runtime node
needs, and no shell or package manager. It runs as the unprivileged user
65532, in home mode, with its data in the `/data` volume and its app files
unpacked read-only at build time. Its health check runs `kin --health`.
For a bind mount instead of a volume, give the folder to that user first:
`sudo chown 65532:65532 /srv/kin-data`. The CI job `home-container` builds
the image and waits for it to report healthy.

Kin listens on loopback inside the container; nothing is published. That is
on purpose: home mode opens no public listener, and with a name set it dials
out to the relay. Set the name with `-e KIN_HOME_NAME=…` (and
`-e KIN_HOME_ACME_TERMS_AGREED=true` once you agree to the CA's terms), or
in `/data/home/settings.json`. The hosted-style image with Caddy in front is still `deploy/`.

## Unsigned builds: what people will see

The owner decided (2026-10-22, #711) that the executables stay **unsigned**
for now: no Apple Developer ID and no Windows code-signing certificate.
They are checksummed instead: check a download against `SHA256SUMS` from the
same release before opening it (`sha256sum -c SHA256SUMS`, or
`Get-FileHash kin.exe` in PowerShell).

- **macOS Gatekeeper** says the app "can't be opened
  because Apple cannot check it for malicious software". Open it once from
  Finder with Control-click › **Open** › **Open**, or in **System Settings ›
  Privacy & Security** choose **Open Anyway**. From Terminal,
  `xattr -d com.apple.quarantine kin` removes the download flag.
  `--install-service` removes it from the installed copy. The executable
  carries an ad-hoc signature (Apple silicon needs one to run anything),
  which says nothing about who built it; `codesign -dv kin` shows
  `Signature=adhoc`.
- **Windows SmartScreen** says "Windows protected your PC". Choose
  **More info › Run anyway**. node.exe's own Authenticode signature is
  removed when Kin is added to it, so Windows shows the publisher as
  unknown. Some antivirus programs also warn
  about a new unsigned program; the checksum is how to tell it is Kin's.
- **Linux** has no such check; `chmod +x` is enough.

A household that can't get past these prompts should use the hosted service
or the container image for now.

## Updates

Kin installed as a service (`kin --install-service`) keeps itself up to date
(ADR 0025 §10, #722). **Until the project's release key is made and built
in, updates are off:** the control panel says so, and Kin makes no requests
for them. Until then, replace the executable and restart the service
(`sudo systemctl restart kin`).

**Checking.** Once a day the launcher fetches
`kin-home-manifest.json` and its signature `kin-home-manifest.json.sig` from
the newest release on GitHub
(`https://github.com/mnichols08/ZTM-Build-Fest/releases/latest/download/…`;
pre-releases are skipped), and checks the Ed25519 signature against the
release key built into Kin before reading anything else. The manifest names
the version, the oldest version that may update to it, and each platform's
file with its size and SHA-256. A release is offered only when it is newer
than this one. `KIN_HOME_RELEASES` points a fork at its own releases.

**Installing.** Patch and minor releases install by themselves at night,
between 02:00 and 05:00 on the computer's clock; turn that off in the
control panel (it is `autoUpdate` in `home/settings.json`) and they wait for
an admin, like major releases always do. An admin installs one with
*Install now*, confirmed like any other change; the launcher picks the
request up within a minute. Installing:

1. downloads this computer's file into the install folder and checks its
   size and SHA-256 against the signed manifest;
2. unpacks its app into its own cache folder, `update-<version>`, leaving
   the running version's files alone;
3. stops the service and makes a backup (reason "before-update",
   [above](#backups-and-restore)) with the database closed;
4. tries the new release as the service, in the sandbox: it must answer
   `/health` within 60 seconds and stay up for 5 minutes;
5. keeps it: the installed executable becomes `kin.previous`, the new one
   takes its place, and Kin goes on running it.

If the trial fails, Kin stops it, puts the backup's database back (the
trial's is kept as `kin.sqlite.failed-update-<time>`), starts the version it
was running and says so in the control panel. It removes the trial's
`update-<version>` folder, waiting a moment if Windows still holds one of
its files; a folder left behind anyway goes the next time Kin starts. That release isn't installed
by itself again; an admin can still try it. Changes that reached the server
during the trial are still on the phones that made them, which send them
again.

Because the old, working launcher tries the new release before anything is
replaced, a release that can't even start leaves Kin running as it was, not
a service manager restarting a broken program.

**What it needs.** The install folder is writable by the account Kin runs
as (the owner's choice for #722): `--install-service` makes the `kin` account
its owner on Linux (and lists it in the unit's `ReadWritePaths`), the
LaunchDaemon's account on macOS, and gives LOCAL SERVICE modify rights on
Windows. The service itself still runs in the sandbox and can write only its
data folder; only the launcher writes the install folder. An executable run
by hand, a checkout and the container image don't replace themselves: the
control panel shows the update with a link to the release (for the
container, pull the new image). Reinstalling with `--install-service` from an
older install grants the rights.

The Windows service host (`kin-service-host.exe`) isn't updated this way;
install again to update it.

**Publishing a release** is in [RELEASES](RELEASES.md#home-server-releases).

## What still needs checking

The tests here ran on Linux x64 with Node 24.22.0. CI on Node 24.22.0 must
confirm the Linux build, the arm64 build (built, not run, in CI), the
container image (`home-container`) and `systemd-analyze verify` of the unit.
The macOS and Windows executables were built and checked on Linux only:
parsed back by Kin's readers and by `llvm-objdump` and `llvm-readobj`, the
ad-hoc signature's page hashes checked, but not run. `home-executables-run`
must confirm that a Mac accepts the signature (`codesign --verify`) and runs
the arm64 executable, and that Windows runs the x64 one; the Mac x64
executable runs in CI only on a runner with Rosetta.

The CI job `service-host` lints and tests the Windows service host on Linux
and Windows, and on Windows builds it and runs it as a real service
(`scripts/service-host-smoke.mjs`): it must start without error 1053,
restart a failed child, stop gracefully with exit code 0, and end a child
that ignores the stop.
The control panel's setup runs end to end against the real relay in test
mode and the in-process CA, in Node and in a headless browser (TESTING, "The
home server's control panel"); a first run against the production relay and
Let's Encrypt, and opening the browser from the launcher on Windows and
macOS, are for #740 and #717.
#717 records install, reboot and uninstall on Windows, macOS, Linux and a
Raspberry Pi.
