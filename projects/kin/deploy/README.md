# Kin test server

A small public server so testers can use Kin from their own devices and
networks (issues #163 and #167), without Tailscale. Two ways to run it:

- **[Railway](railway/README.md):** Railway builds and hosts it; no server to
  look after.
- **Your own Linux server with Docker** (this page).

On your own server it runs two containers:

- **kin**: the Node service and web app, with the WebAssembly engine built
  into the image. It listens on loopback only, as Kin requires.
- **caddy**: shares Kin's network namespace, gets and renews the HTTPS
  certificate for your subdomain, and is the only way in.

Kin's database lives in a Docker volume, so restarts and updates keep it.

> This is a **test server**. Data on it is test data: v1.0 starts fresh
> ([V1.0-COMPATIBILITY](../docs/V1.0-COMPATIBILITY.md)), so testers shouldn't
> keep anything they need here. The relay only ever holds encrypted data, but
> the [known limitations](../docs/THREAT-MODEL.md#known-limitations-at-v10)
> still apply.

For a household's own home server (one executable, a service, or the
distroless image) rather than a test server, see
[HOME-SERVER](../docs/HOME-SERVER.md).

## What you need

- A Linux server with Docker Engine and the Compose plugin (a Hetzner cloud
  server is plenty; 2 GB RAM is enough to build the image).
- A subdomain, for example `kin.yourdomain.com`, with a DNS **A** record (and
  **AAAA** if the server has IPv6) pointing at the server.
- Ports **80** and **443** open to the internet (Hetzner's cloud firewall, if
  you use one, and any firewall on the server). Caddy needs both for the
  certificate.

Passkeys are tied to the domain name. Pick the subdomain you'll keep for the
whole test: changing it later means every tester sets up again.

## 1. Free the server (if something else is running)

Stop whatever is using ports 80 and 443. For an old Compose project:

```sh
cd /path/to/old-project && docker compose down
docker ps            # nothing should still publish 0.0.0.0:80 or :443
```

## 2. Get the code and configure

```sh
git clone https://github.com/mnichols08/ZTM-Build-Fest.git
cd ZTM-Build-Fest
git switch kin-testing        # the branch testers get; see railway/README.md#testing-branch
cd projects/kin/deploy
cp .env.example .env
nano .env            # set KIN_DOMAIN=kin.yourdomain.com
```

`.env` settings:

| Setting | What it does |
| --- | --- |
| `KIN_DOMAIN` | The subdomain testers open. Required. |
| `KIN_MAX_HOUSEHOLDS` | Refuses new households once this many exist (default 10). |
| `KIN_ALLOW_NEW_HOUSEHOLDS` | Set to `false` once your testers' households exist. |

## 3. Start it

```sh
docker compose up -d --build
docker compose logs -f
```

The first build takes a few minutes (it compiles the Rust engine). You're
ready when the logs show `{"event":"service_ready","origin":"https://kin.yourdomain.com"}`
from **kin** and Caddy reports `certificate obtained successfully`. Open
`https://kin.yourdomain.com`.

If Caddy can't get a certificate, check that the DNS record points at this
server and that ports 80 and 443 are open.

## Update to the latest code

```sh
cd ZTM-Build-Fest && git pull
cd projects/kin/deploy && docker compose up -d --build
```

If the site stops responding after an update, run `docker compose restart caddy`
(Caddy shares Kin's network namespace and must follow a recreated Kin container).

Kin's offline cache updates itself: testers see an update prompt the next time
they open the app.

## Close sign-ups

Once everyone has created or joined their household, set
`KIN_ALLOW_NEW_HOUSEHOLDS=false` in `.env` and run `docker compose up -d`.
Existing households keep working, and invites into them still work. Anyone
else sees "This Kin server isn't accepting new households."

## Back up and look around

```sh
# An integrity-checked copy of the database, kept in the data volume
docker compose exec kin node server/admin.mjs backup /data/backup-$(date +%F).sqlite

# Status and logs
docker compose ps
docker compose logs --tail 100 kin
```

## Restore a backup

Kin must be stopped while its database is replaced:

```sh
docker compose cp ./kin-backup.sqlite kin:/data/kin-backup.sqlite
docker compose run --rm --no-deps -u root kin chown node:node /data/kin-backup.sqlite   # Kin backups are private to their owner
docker compose stop kin
docker compose run --rm --no-deps kin node server/admin.mjs restore /data/kin-backup.sqlite --acknowledge-deletion-history
docker compose up -d && docker compose restart caddy
```

The replaced database is kept next to it as `kin.sqlite.pre-restore-…`. To
move a [Railway](railway/README.md) test server here, copy one of its
`/data/backups` files over and restore it this way, keeping the same domain.

## Start over

This deletes every household on the test server:

```sh
docker compose down -v
```

## How it fits together

```text
tester's browser ──HTTPS──▶ caddy :443 ──▶ 127.0.0.1:8000 kin (same network namespace)
                                               │
                                               └── /data  (kin-data volume: kin.sqlite)
```

- `KIN_ORIGIN` is `https://KIN_DOMAIN`; Kin refuses a non-HTTPS public origin.
- `KIN_TRUSTED_PROXIES=127.0.0.1,::1`, and Caddy replaces `X-Forwarded-For`
  with the address it received, so the per-client limits (pairing guesses,
  new households) see each tester's real address.
- The image has no npm packages; the only third-party software is the Node,
  Rust (build stage only) and Caddy base images.
