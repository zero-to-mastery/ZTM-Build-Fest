# Development Workflow

**Status:** current as of v1.6.0. For running Kin on a server rather than developing it, see [SELF-HOSTING](SELF-HOSTING.md); for the contributor workflow, [CONTRIBUTING](../CONTRIBUTING.md).

## Build and run

```text
clone the ZTM Build Fest repository
        |
        v
work inside projects/kin/
        |
        v
install rustup/Cargo and the wasm32-unknown-unknown target
        |
        v
build the Rust/WASM module using the project-local manifest
        |
        v
        serve HTML, assets, and same-origin APIs from the Kin Node server
        |
        v
        open the supported browser and exercise Today + Needs + Handoff + Talk + Pulse + catch-up
```

From the repository root in PowerShell:

```powershell
npm ci --prefix projects/kin
./projects/kin/run.ps1
```

The launcher builds the WASM module and serves the web app at `http://localhost:8000`; press Ctrl+C to stop it. On macOS/Linux, run `sh projects/kin/run.sh` from the repository root. Never run Cargo from the Build Fest repository root for Kin; generated artifacts belong under `projects/kin/`.

Wait for the server's `service_ready` event before opening the app. A
`startup_failed` event with `outcome: "listen_failed"` includes the attempted
host, port, operating-system error code, and recovery guidance. `EADDRINUSE`
means another listener is using that address; `EACCES` means the operating
system denied the bind (for example, a reserved port); `EADDRNOTAVAIL` means
the selected host is unavailable. In PowerShell, inspect the port reported in
the error with `Get-NetTCPConnection -LocalPort 8000 -State Listen` (replace
`8000` as needed), then inspect its `OwningProcess` before stopping anything.
Check `Get-ChildItem Env:KIN_*` in the failing terminal for configuration
overrides. Kin does not automatically switch ports: a different browser origin
uses different local storage. A failed bind releases the service's database
lock; deleting data or a lock does not resolve a listen failure.

## First-class operating systems

Windows, macOS, and Linux are intended development environments. Documentation and future scripts must not assume Bash, GNU-only utilities, POSIX path syntax, or a Unix package manager. Prefer Cargo/rustup and portable project commands. Where a command differs, show native PowerShell and shell equivalents rather than forcing developers to install a compatibility shell.

Windows developers should be able to use PowerShell and standard Rust tooling. macOS and Linux developers should be able to use their standard shells and rustup. Compiler/browser differences should be captured in issue reports with OS and version details.

## Intended minimal tools

- Rust toolchain (`rustup`, `cargo`) and the `wasm32-unknown-unknown` target
- A modern secure-context browser with WebAssembly, Web Crypto, IndexedDB, Web Locks, BroadcastChannel, service workers and the platform APIs in [IMPLEMENTATION](IMPLEMENTATION.md)
- Node.js 24.16.0 or later and npm for the same-origin application/API server and built-in tests; SQLite uses the built-in `node:sqlite` API, with no npm runtime dependencies
- Python 3.11 or later for version checks and launcher smoke tests; it is not needed to serve the app

On Windows, `run.ps1` uses Node.js from PATH when it meets the 24.16.0 minimum. If PATH selects an older version, it uses the lowest compatible version already installed through fnm. The script does not install runtimes. On macOS and Linux, put Node.js 24.16.0 or later on PATH before running `run.sh`.

`rust-toolchain.toml` pins Rust 1.93.0 with the `wasm32-unknown-unknown`
target, and the verification gate and release builds use that pin. If the
pinned toolchain cannot be installed (for example offline, or with a mirror
that lacks it), a local build or test run can use your default stable toolchain
for that one command without editing the pin:

```powershell
$env:RUSTUP_TOOLCHAIN = "stable"; cargo test --manifest-path Cargo.toml; Remove-Item Env:RUSTUP_TOOLCHAIN
```

```sh
RUSTUP_TOOLCHAIN=stable cargo test --manifest-path Cargo.toml
```

Stable needs the same target (`rustup target add wasm32-unknown-unknown
--toolchain stable`). Treat such a run as a convenience check. Its WASM may
differ in bytes from the pinned build, formatting or Clippy findings may
differ, and it does not count as a pass of the gate.

### The service sandbox

The service runs under Node's permission model (#106). `server/start.mjs`
(which `npm start`, `run.sh`, `run.ps1` and the container use) creates the
data directory, then starts `server/server.mjs` with `--permission`, read
access to the app directory and read and write access to the data directory
only. The service cannot start child processes or workers, or load addons or
WASI, and it refuses to start without the sandbox, naming any path missing
from its allowlist. `server/permissions.mjs` builds the flags.

- `npm run dev` runs `node --watch server/server.mjs --unrestricted`: Node's
  watch mode restarts the service as a child process, which the sandbox
  forbids, so development runs without it and logs that it did.
- Maintenance commands (`server/admin.mjs` backup and restore,
  `deploy/railway/snapshot.mjs`) run outside the sandbox as short-lived
  processes, because they write outside the data directory.
- The permission model checks Node's own file APIs. SQLite's file I/O is
  native and unchecked (SQL such as `ATTACH` could write elsewhere); no
  request input reaches SQL text. `fsync` is unavailable inside the sandbox,
  so anything that needs durable writes belongs in SQLite.
- The launcher passes the canonical database path to the service, because the
  model compares paths as written: a symlinked data directory works through
  `start.mjs`. A data directory that is the app directory, or contains it, is
  refused.
- Running `node server/server.mjs` directly (for example from a systemd unit)
  is refused; use `node server/start.mjs`, or `--install-service` to write
  the unit (docs/HOME-SERVER.md).
- The launcher itself is `server/launcher.mjs`; `start.mjs` and the home
  server's single executable (`scripts/sea/main.cjs`) both use it. The
  executable can't pass Node flags on its command line, so it starts its
  service copy with the same flags in `NODE_OPTIONS`.
- Node's permission model disables `fsync`, so the service's lock file is not
  fsynced (the exclusive create is the lock; its content is diagnostic). The
  database's own durability is SQLite's.
- Node tests that start the service run it inside the same sandbox, and
  `server/permissions.test.mjs` checks that writes outside the data directory,
  child processes and workers are denied. The gate gives every Node test a
  two-minute timeout.

Node.js 24.16.0 is the supported runtime floor: earlier Node 24 releases (and Node 22) can corrupt `node:sqlite` TEXT values that contain NUL characters. CI runs Node 24.22.0 on Windows and Linux. Other operating-system and runtime/architecture combinations remain unverified.

## Checking your change

`npm run verify` runs the full gate (static checks, every Node and Rust test,
the WASM build); `npm run verify:browser` adds the browser suites, finding an
installed Edge, Chrome or Chromium and building the browser engine if it is
missing. Without the `wasm32` target, `node scripts/fetch-wasm.mjs` installs
the engine CI built for your pushed commit, and
`node scripts/verify.mjs --browser-only` runs the browser suites against it.
Details: [TESTING](TESTING.md#run-the-browser-gates-locally).

## Browser capabilities

The application requires WebAssembly, ES modules, Custom Elements, IndexedDB, Web Locks, `BroadcastChannel`, `CustomEvent`, text encoders/decoders and Web Crypto. WebAuthn is used for server identity and pairing. Credential-bound local unlock additionally requires actual PRF output; the independently held recovery key remains the explicit fallback and works offline. Web Locks are required for safe v0.9.3 migration. The service worker caches only an allowlisted static shell. Browser validation is recorded per release and does not certify the full support target.

## Application shell updates while developing

The service worker caches the complete static shell under a name derived from
the release in its registration URL and never re-stages an existing cache
name. The Kin server therefore serves `index.html` with the release plus
semver build metadata, `0.41.0+<12-hex fingerprint>`, where the fingerprint
hashes the relative paths and bytes of every served file under `web/` (test
files excluded). It is deterministic across restarts and file timestamp
changes, and changes when any served content changes. Any edit to a shell file yields a new cache
name, so an open browser is offered "A new Kin version is ready" on its next
load instead of keeping a frozen mix of old and new modules. The static
`index.html` keeps the plain release for version checks, and the test-suite
static servers (which serve the raw file) keep the plain cache name. Accept
the update prompt after changing shell files; if a browser was captured on a
stale cache before this fingerprint existed, unregister its service worker
once (DevTools → Application → Service Workers) and reload. Never "clear site
data" for the origin, which deletes the local encrypted household database.

## App and shortcut icons

`web/icons/*.png` (the 192 and 512 px app icons, the maskable 512 px icon
and a 96 and 192 px icon per home-screen shortcut) are generated by
`scripts/render-icons.mjs`, which draws them from hand-coded geometry with
Node's built-ins only (its own rasterizer, CRC-32 and PNG encoder over
`zlib`). The app icon is `web/icon.svg` drawn exactly; the shortcut icons
are the same tile with one glyph each. After changing the geometry:

```sh
node scripts/render-icons.mjs          # writes web/icons/*.png
node scripts/render-icons.mjs --check  # fails if a committed PNG differs
```

Commit the PNGs with the script. `scripts/render-icons.test.mjs` fails when
they drift apart, and checks every icon the manifest names exists. Add a new
shortcut's glyph to `GLYPHS` in the script, its icons to the manifest and the
service worker's shell list, and its landing to
`scripts/shortcuts-badge-regression.mjs`.

The Google Play feature graphic, `play/feature-graphic.png` (1024 × 500,
no alpha, #540), is drawn from the same geometry by
`scripts/render-play-graphics.mjs` (same `--check`; tested by
`scripts/render-play-graphics.test.mjs`). Play Store screenshots come from
`scripts/play-screenshots.mjs`; see [PLAY-LISTING](PLAY-LISTING.md#screenshots).

## Development data

Use synthetic household text only. Never copy private family messages, health details, credentials, or real household history into test fixtures, screenshots, bug reports, or logs. Local test data can be removed through the browser's site-data controls for the local origin. No database-wide clear command is provided; use isolated temporary databases for tests and the in-app deletion flow for real household data.

The service database defaults to `projects/kin/.kin-data/kin.sqlite`, outside
the static web root. `KIN_DATA_DIR` or `KIN_DATABASE_PATH` can select another
location. The production server holds an exclusive adjacent
`<database-path>.service.lock`. Backup and restore share an adjacent
`<database-path>.maintenance.lock`; restore also takes the service lock and
requires the service to be stopped. Backup may run while the service is active,
using SQLite's `VACUUM INTO` snapshot support. Graceful completion releases
owned locks, while a crash or hard kill can leave a stale lock. Kin does not
reclaim locks automatically.

If startup or an admin operation reports an existing lock, use the exact absolute
lock path in the error. Each lock contains JSON with `pid`, `operation`,
`startedAt` (Unix time in milliseconds), and a random ownership `token`. Inspect
it locally with `Get-Content -LiteralPath '<lock-path>'` in PowerShell or
`cat '<lock-path>'` in a POSIX shell. Check the recorded PID with
`Get-CimInstance Win32_Process -Filter 'ProcessId = <pid>'` (PowerShell) or
`ps -p <pid> -o pid,lstart,args` (POSIX), and check the service manager and any
backup/restore jobs for this database. Compare the command, database configuration
and process start time; a PID alone is not proof because it may have been reused.

Stop Kin and disable automatic restart/admin jobs while diagnosing. Only after
confirming that no Kin service, backup or restore operation is using the database
may the stale lock file be removed manually: use
`Remove-Item -LiteralPath '<lock-path>'` (PowerShell) or `rm -- '<lock-path>'`
(POSIX), then retry the intended operation. Replace placeholders with the exact
verified path/PID. Never remove a lock while its owner or another operation is
active. Remove only the stale lock file, never the database or its WAL/SHM files.

Backups are sensitive and must be stored outside the static web root:

```powershell
npm run backup -- C:\private\kin-backups\kin.sqlite
npm run restore -- C:\private\kin-backups\kin.sqlite --acknowledge-deletion-history
```

Restore requires an explicit acknowledgement that the backup may predate
household deletions. It requires the service to be stopped and refuses restore
if any target household has a pending deletion. Cancel deletion using current
valid household authority or allow it to finalize before restoring; this
prevents restoring stale cancellation authority during the grace period.
For active/finalized targets it verifies the source, merges existing finalized
deletion tombstones so deleted household rows stay purged/non-authoritative, and preserves
the replaced database/WAL sidecars as a `.pre-restore-...` copy. Missing, empty,
directory or unsupported-schema restore sources are rejected before replacement;
restore does not initialize a new database from an invalid backup. A database
restored without its later deletion history can roll identity and authorization
state backward; the explicit warning is not rollback protection when both the
current database and its tombstones have been lost. Keep service backups
separate from local encrypted browser archives.

Startup and every `/readiness` check validate SQLite structure and Kin's durable
identity, routing, sequence and epoch invariants across all households. Semantic
corruption stops startup or returns readiness HTTP 503 without exposing rows or
paths; `/health` remains liveness. Backup source/copy and restore source use the
same validator. Kin does not automatically repair inconsistent authorization.
Validation pages relay history but runs synchronously, so readiness latency
grows with stored history; see [measurements](planning/V0.11.0.md#v0115-semantic-integrity-evidence-2026-10-03).
