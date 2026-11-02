# Kin test server on Railway

Railway builds Kin from this repository and serves it over HTTPS on your own
subdomain. There's no server to look after: you connect the repo, set a few
variables, attach a volume and add one DNS record.

> This is a **test server**. Data on it is test data: v1.0 starts fresh
> ([V1.0-COMPATIBILITY](../../docs/V1.0-COMPATIBILITY.md)). The relay only
> ever holds encrypted data, but the
> [known limitations](../../docs/THREAT-MODEL.md#known-limitations-at-v10)
> still apply.

## How it works

Railway sends traffic to a public port in your container, but Kin only listens
on loopback. So this image runs two processes: a small Caddy on Railway's
`$PORT`, passing requests to Kin on `127.0.0.1:8000`. Railway's edge handles
HTTPS and the certificate. Railway overwrites `X-Real-IP` with each visitor's
address, and Caddy hands that to Kin, so the per-person limits (pairing-code
guesses, new households) see real addresses and ignore anything a client
writes itself.

```text
browser ──HTTPS──▶ Railway edge ──▶ $PORT caddy ──▶ 127.0.0.1:8000 kin ──▶ /data (volume)
```

## 1. Pick the address first

Passkeys are tied to the domain name, so decide the address testers will use
before anyone sets up: your own subdomain (for example `kin.yourdomain.com`) or
the free `something.up.railway.app` one. Changing it later means every tester
sets up again.

## 2. Create the service

1. In Railway: **New Project → Deploy from GitHub repo →**
   `mnichols08/ZTM-Build-Fest`.
2. Open the service's **Settings**:
   - **Source → Root Directory:** `projects/kin`
   - **Source → Branch:** `kin-testing` (see [Testing branch](#testing-branch):
     testers only get new code when you choose to promote it)
   - **Source → Watch Paths:** `/projects/kin/**` (so other projects in the
     repo don't redeploy Kin)
   - **Deploy → Healthcheck Path:** `/health`
   - **Deploy → Replicas:** `1`. Kin's database is one SQLite file and allows
     one server process.
   - Leave **serverless / app sleeping** off.
3. **Variables** (the Variables tab):

   | Variable | Value |
   | --- | --- |
   | `KIN_ORIGIN` | `https://kin.yourdomain.com` (the address from step 1, with `https://`, no trailing slash) |
   | `KIN_MAX_HOUSEHOLDS` | optional; defaults to `10` |
   | `KIN_ALLOW_NEW_HOUSEHOLDS` | optional; set to `false` once testers' households exist |
   | `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | `10` (recommended): how long Railway lets the old container shut down before force-stopping it, so Kin can finish requests and close its database cleanly |

4. **Volume (required):** right-click the service (or use the command
   palette) → create a volume for this service, mount path **`/data`**. It
   then appears under the service on the project canvas. Without it, every
   deploy starts with an empty database: all households are gone and testers'
   passkeys stop working. Kin refuses to start when `/data` isn't a volume and
   says so in the deploy logs (`/data is not a mounted volume…`).

## 3. Connect your subdomain

1. Service **Settings → Networking → Custom Domain**, enter
   `kin.yourdomain.com`. Railway shows a **CNAME** target (and sometimes a TXT
   record to prove you own the domain).
2. In **Squarespace → Domains → your domain → DNS settings**, add the record(s)
   exactly as Railway shows them: type `CNAME`, host `kin`, data the Railway
   target. Remove any other record for the same host first (an old A record or
   forwarding).
3. Railway issues the certificate once DNS has updated, usually within minutes.

Using the free `*.up.railway.app` address instead? **Networking → Generate
Domain**, and set `KIN_ORIGIN` to that address.

## 4. Deploy and check

Railway deploys after the settings change (or press **Deploy**). The first
build takes several minutes because it compiles Kin's Rust engine. In the
deploy logs, wait for:

```text
{"event":"service_ready","origin":"https://kin.yourdomain.com"}
```

Then open your address. If the logs say `Set the KIN_ORIGIN variable…`, the
variable is missing. If the build can't find a Dockerfile, check that Root
Directory is exactly `projects/kin`: Railway uses `projects/kin/Dockerfile`
from there automatically. Remove any `RAILWAY_DOCKERFILE_PATH` variable left
from an earlier setup.

## Testing branch

Railway deploys the `kin-testing` branch, not `kin-development`. Merging work
into `kin-development` no longer touches the test server; you decide when
testers get it.

**Promote** the current `kin-development` to testers by opening a pull request
from `kin-development` into `kin-testing` and merging it (or, from a clone,
`git push origin origin/kin-development:kin-testing`). Railway redeploys; before
the new code touches the database, the startup script saves a copy of it as the
previous version left it (below). Testers see the update prompt the next time
they open Kin.

Promote when CI is green and you aren't in the middle of a test session.
Households, passkeys and data carry over: the server database stays on the
volume, and v1.0's formats are frozen
([V1.0-COMPATIBILITY](../../docs/V1.0-COMPATIBILITY.md)).

## Backups

Once per deployment, before Kin opens the database, the startup script writes
an integrity-checked copy to `/data/backups/kin-<UTC time>.sqlite` and keeps the
newest 10 (`KIN_BACKUPS_KEEP` changes that). The copy is made without running
any Kin code, so it holds the database exactly as the previous deployment left
it, before the new version upgrades anything. The deploy log shows
`backup_created`. Restarts within the same deployment, including a crash loop,
log `backup_skipped` and don't add copies, so they can't push good backups
out.

Each copy is the size of the database (small for a test server). If the volume
gets close to full, lower `KIN_BACKUPS_KEEP` or delete old
`kin.sqlite.pre-restore-…` files left by restores.

The first start on a new volume logs `database_new` instead. If you see that on
a server that already had households, the volume isn't the one you expected.

To take one on demand, from the service's shell (Railway CLI `railway ssh`, or
the dashboard). The shell is root, so run it as Kin's user:

```sh
setpriv --reuid=node --regid=node --init-groups -- \
  node /app/server/admin.mjs backup /data/backups/manual-$(date +%F).sqlite
```

## Roll back or move data

Kin can only replace its database while it isn't running, so a restore happens
at startup:

1. Find the backup to use: `ls -lt /data/backups` from the service's shell, or
   the `backup_created` lines in earlier deploy logs.
2. Set the variable `KIN_RESTORE_FROM=/data/backups/kin-<time>.sqlite` and
   deploy the change (Railway stages variable changes until you deploy them).
3. The deploy log shows `restore_finished`. The database it replaced is kept
   next to it as `kin.sqlite.pre-restore-…`.
4. Delete the `KIN_RESTORE_FROM` variable and deploy again. If you forget, it
   isn't applied a second time: the log says `restore_skipped`. To restore the
   same file again later, delete `/data/backups/.restored-<file name>` first.

If the problem came with new code, also move `kin-testing` back to the earlier
commit; a backup taken by older code may not open with newer code.

To **move** a test server's data to a new Railway service or another server,
copy a backup file into the new server's `/data/backups` and restore it the
same way (for the Docker setup, see
[Restore a backup](../README.md#restore-a-backup)). The Railway CLI moves
files in and out of a volume: `railway volume browse /` to look around, or
`railway volume files download` / `railway volume files upload`
([Railway: Volumes](https://docs.railway.com/guides/volumes)). Keep the same
address: passkeys only work on the domain they were made on.

What a restore does and doesn't bring back:

- Encrypted sync history goes back to when the backup was taken. Anything that
  reached the server after that is gone from it, so pick the newest backup
  that predates the problem.
- For each household that exists right now, the current members, passkeys,
  devices and key state are kept from the database being replaced, so a
  rollback can't bring back a removed device. Household deletions made since
  the backup are kept too.
- Kin refuses a backup from before a household that exists now was created
  (`Cannot restore a backup that predates a currently active household`).
  Restoring into a new, empty server always works.

### "A Kin service or maintenance lock already exists"

Kin keeps a lock file beside its database while it runs and removes it when it
stops. If Railway force-stops the old container on a redeploy before Kin has
closed, the lock is left on the volume. The startup script removes such a
leftover lock before Kin starts and logs `stale_lock_removed`: Railway never
mounts a volume on two deployments at once, so at startup no other Kin can be
using it. You don't need to wipe the volume. Setting
`RAILWAY_DEPLOYMENT_DRAINING_SECONDS` (above) gives Kin time to close cleanly
so it usually isn't needed.

## Day to day

- **Updates:** promote `kin-development` into `kin-testing`
  ([Testing branch](#testing-branch)).
- **Close sign-ups:** set `KIN_ALLOW_NEW_HOUSEHOLDS=false`. Existing households
  keep working and can still invite people; anyone else sees "This Kin server
  isn't accepting new households."
- **Back up / roll back:** automatic at every start; see [Backups](#backups).
- **Start over:** delete the volume and attach a new one at `/data`. This
  removes every household and its backups.

## Cost

Kin is small: one container and a volume of a few megabytes. Railway's Hobby
plan covers it; check Railway's pricing page for current rates.
