# Development Workflow

**Status:** v0.11.7 durable-service implementation candidate (October Roadmap & Startup Diagnostics); awaiting human review. Earlier version sections remain historical contracts.

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
- Node.js 22 or later and npm for the same-origin application/API server and built-in tests; the locked `better-sqlite3` dependency is a native addon
- Python 3.11 or later for version checks and launcher smoke tests; it is not needed to serve the app

The current implementation has been exercised on Windows with Node 22.12. Other operating-system and runtime/architecture combinations remain unverified; do not infer support from the npm package's availability.

## Browser capabilities

The application requires WebAssembly, ES modules, Custom Elements, IndexedDB, Web Locks, `BroadcastChannel`, `CustomEvent`, text encoders/decoders and Web Crypto. WebAuthn is used for server identity and pairing. Credential-bound local unlock additionally requires actual PRF output; the independently held recovery key remains the explicit fallback and works offline. Web Locks are required for safe v0.9.3 migration. The service worker caches only an allowlisted static shell. Browser validation is recorded per release and does not certify the full support target.

## Development data

Use synthetic household text only. Never copy private family messages, health details, credentials, or real household history into test fixtures, screenshots, bug reports, or logs. Local test data can be removed through the browser's site-data controls for the local origin. Kin does not include a reset command that could accidentally remove household data.

The service database defaults to `projects/kin/.kin-data/kin.sqlite`, outside
the static web root. `KIN_DATA_DIR` or `KIN_DATABASE_PATH` can select another
location. The production server holds an exclusive adjacent
`<database-path>.service.lock`. Backup and restore share an adjacent
`<database-path>.maintenance.lock`; restore also takes the service lock and
requires the service to be stopped. Backup may run while the service is active,
using SQLite's backup API. Graceful completion releases owned locks, while a
crash or hard kill can leave a stale lock. Kin does not reclaim locks automatically.

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
npm run restore -- C:\private\kin-backups\kin.sqlite
```

Restore requires the service to be stopped, verifies the source, and preserves
the replaced database/WAL sidecars as a `.pre-restore-...` copy. Missing, empty,
directory or unsupported-schema restore sources are rejected before replacement;
restore does not initialize a new database from an invalid backup. A database
backup can roll identity and authorization state backward (including revocation
and key epochs); it is not a rollback-proof recovery mechanism. Keep service
backups separate from local encrypted browser archives.

Startup and every `/readiness` check validate SQLite structure and Kin's durable
identity, routing, sequence and epoch invariants across all households. Semantic
corruption stops startup or returns readiness HTTP 503 without exposing rows or
paths; `/health` remains liveness. Backup source/copy and restore source use the
same validator. Kin does not automatically repair inconsistent authorization.
Validation pages relay history but runs synchronously, so readiness latency
grows with stored history; see [measurements](V0.11.0.md#v0115-semantic-integrity-evidence-2026-10-03).

## v0.5.0 Pulse

Pulse uses the established build/run scripts and complete regression runner. No runtime dependency or parent-level build changes. See [V0.5.0](V0.5.0.md).

## v0.6.0 Since You Last Looked

Catch-up behavior is local to the browser installation and uses the canonical event store plus the existing WASM build and browser regression workflows. Use synthetic test events only; do not put real household history into fixtures or diagnostics. The v0.6 browser suite exercises cursor races, reload, keyboard/focus, content-free tab invalidation, and accessibility modes. No additional runtime dependency or parent-level build change is required. See [V0.6.0](V0.6.0.md).
