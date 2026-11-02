# Kin

> A private, lightweight household coordination app for the little things families need to know, remember, hand off or talk about.

**Current implementation line: `v1.6.0` — Kin for Everyone**, released
2026-10-21 as `kin-v1.6.0`. A hosted instance runs at
<https://kin.journeytocode.io>, and you can [run your own](#run-kin-on-your-own-server).
Kin is an entry in the ZTM Build Fest and lives in this repository under
`projects/kin/`; treat that folder as the project root.

- [What Kin is](#what-kin-is)
- [What it does today](#what-it-does-today)
- [Run Kin locally](#run-kin-locally)
- [Run Kin on your own server](#run-kin-on-your-own-server)
- [Check a change](#check-a-change)
- [Repository layout](#repository-layout)
- [Documentation](#documentation)
- [Privacy and security](#privacy-and-security)
- [AI usage](#ai-usage)
- [Contributing and community](#contributing-and-community)
- [License](#license)
- [Release history](#release-history)

## What Kin is

Household information gets scattered across memory, messages, calendars,
sticky notes and assumptions. Small handoffs get missed, and everyday
coordination turns into "I thought you knew" and "I thought you were doing
that". Kin gives a household one calm place for what matters today, what
changed since you last looked, and what someone needs from someone else.

It is built for the tired parent holding a child: add something in a tap and a
few words, see what needs doing, hand something off, and leave. Kin
coordinates; it does not judge. There are no streaks, scores, contribution
percentages or rankings, and nothing watches anyone.

Technically, Kin is a local-first web app. Each device keeps the household's
history as an encrypted event log in the browser, a Rust engine compiled to
WebAssembly replays that log into what you see, and a small Node.js service
relays encrypted events between a household's devices without ever being able
to read them. There are no frameworks and no npm runtime dependencies: native
Web Components, vanilla JavaScript, browser APIs, Rust and SQLite.

## What it does today

- **Today, Lists, Routines, Updates, Household.** Five destinations on every
  screen size: what matters today; To do, Shopping, Staples and Meals; routines
  that repeat daily, weekly, fortnightly or monthly, with turns; handoffs,
  things to talk about later and one household chat room; and everything about
  the household itself.
- **The family hub.** A shared calendar (with outside calendars synced in),
  This week, a kitchen display for a wall tablet, a chore chart with rewards, a
  family photo album and photo frame, a fridge door to draw on, and fuller meal
  plans with recipes.
- **A private space for each member.** A journal, a Just for me list, reminders
  and settings that follow you between devices, and a private export.
- **Accounts and devices.** A username and password, an optional passkey and a
  backup code; adding your own phone or computer, inviting another person by QR
  code, and trusted devices an admin can revoke. Up to four adults, plus Limited
  (children) and Temporary (sitters, guests) members.
- **For everyone.** Easy mode with bigger text and fewer things on screen, a
  Simple view, Help on every screen, setting Kin up for someone else with a
  printed sheet, and reporting a problem from inside the app.
- **Works offline and installs.** A progressive web app with an offline shell,
  push notifications, keyboard shortcuts and a command palette, undo and redo,
  bulk actions, search, share-into-Kin and list import. An Android app for
  Google Play is in `android/` (built in CI; not yet published).

Everything above is implemented and covered by the verification gate. Work
after v1.0 is tracked as GitHub issues rather than dated versions; the
[roadmap](docs/ROADMAP.md) records how Kin got here. Kin has not had an
independent security audit; see [what it does not protect against](docs/THREAT-MODEL.md#known-limitations-at-v10).

## Run Kin locally

You need:

- **Node.js 24.16.0 or later**. Kin uses Node's built-in SQLite and has no
  npm dependencies at all, so there is nothing to install; `npm ci` below
  finishes instantly and only confirms the lockfile.
- **Rust** via `rustup`, with the `wasm32-unknown-unknown` target. The
  toolchain is pinned to 1.93.0 by `rust-toolchain.toml`; rustup installs it
  on first use.
- A current browser with WebAssembly, IndexedDB, Web Crypto and passkeys.
  CI validates Edge and Chrome; Firefox and Safari are expected to work but
  are not certified.

Then, from `projects/kin/`:

```powershell
# Windows (PowerShell)
npm ci
rustup target add wasm32-unknown-unknown
./run.ps1
```

```sh
# macOS and Linux
npm ci
rustup target add wasm32-unknown-unknown
sh run.sh
```

The script builds the WebAssembly engine, then starts the service inside
Node's permission sandbox. When the log shows
`{"event":"service_ready",…}`, open <http://localhost:8000>, choose **Start a
new household**, and keep the recovery key it shows you somewhere safe: Kin
cannot recover a household whose every unlock path is lost. The database is
created at `.kin-data/kin.sqlite` (ignored by Git).

On Windows, if the Node on your PATH is too old, `run.ps1` uses the lowest
compatible version already installed through fnm; it does not install Node.
For day-to-day development, `npm run dev` restarts the service when server
files change (outside the sandbox, which watch mode does not allow), and
`npm start` runs it as the launcher does. More in
[DEVELOPMENT](docs/DEVELOPMENT.md).

## Run Kin on your own server

Kin is one Node process and one SQLite file behind a TLS proxy. Four ways to
run it, from least to most hands-on:

| | |
| --- | --- |
| **Railway** | Connect the repository, attach a volume, set one variable and one DNS record. [deploy/railway/](deploy/railway/README.md) |
| **Docker Compose** on a Linux server | Kin plus Caddy, which gets the certificate for your subdomain. `cd deploy && cp .env.example .env && docker compose up -d --build`. [deploy/](deploy/README.md) |
| **Node behind your own proxy** | nginx, Caddy or Traefik in front of `node server/start.mjs`. |
| **Kin at home** (in progress) | One executable for Linux x64 and arm64 (macOS and Windows follow) or a container, installed as a service on a computer at home. With a name set, it dials out to the connection relay and phones reach it there over TLS that ends on the home server (#733). On first run a setup page on the computer itself chooses the name, gets the certificate and leads to creating the household; afterwards it is the home server's status page, for household admins too (#719, #720). It backs itself up every night and restores from the control panel (#721), and updates itself from signed releases, trying each before keeping it (#722; off until the release key is built in). Moving a household from the hosted service comes next. [HOME-SERVER](docs/HOME-SERVER.md), [ADR 0025](docs/decisions/0025-kin-at-home.md) |

Every setting, the reverse-proxy rules, health endpoints, backups and
restore, updating, and the optional GitHub forwarding of in-app reports are in
[SELF-HOSTING](docs/SELF-HOSTING.md). Decide the public address before the
first member signs up: passkeys are tied to the domain name.

## Check a change

```sh
npm run verify            # static checks, every Node and Rust test, the WASM build
npm run verify:browser    # plus the browser suites, in an installed Edge, Chrome or Chromium
```

The same gate runs in CI as the "Kin verification" workflow on every pull
request that touches `projects/kin/`. [TESTING](docs/TESTING.md) explains the
suites, how to run one of them on its own, and what to do about a flake.

## Repository layout

```text
projects/kin/
├── rust/           The household engine: events, replay, validation (Rust → WASM)
├── web/            The app: components/ (Web Components), wasm/ (engine loaders),
│                   styles/, service-worker.js, privacy.html
├── server/         The Node service: server.mjs, start.mjs (sandboxed launcher),
│                   admin.mjs (backup, restore, feedback)
├── scripts/        The verification gate and the browser regression suites
├── deploy/         Docker Compose and Railway deployments
├── android/        The Android app for Google Play (Trusted Web Activity)
├── play/           Store listing assets
├── docs/           Documentation; start at docs/README.md
├── run.sh, run.ps1 Build the engine and start the service
└── Cargo.toml, package.json, rust-toolchain.toml
```

## Documentation

[docs/README.md](docs/README.md) maps every document. The ones most people
need:

- [PRODUCT](docs/PRODUCT.md) and [PRINCIPLES](docs/PRINCIPLES.md): what Kin
  is for and what it will never do.
- [ARCHITECTURE](docs/ARCHITECTURE.md): how the engine, the components, the
  event log and the service fit together.
- [UX](docs/UX.md): how every screen behaves.
- [PRIVACY](docs/PRIVACY.md) and [THREAT-MODEL](docs/THREAT-MODEL.md).
- [V1.0-COMPATIBILITY](docs/V1.0-COMPATIBILITY.md): the formats frozen at v1.0
  and the promise that every v1.x release keeps reading them.
- [decisions/](docs/decisions/): the architecture decision records.
- [CHANGELOG](CHANGELOG.md): every version, newest first.

## Privacy and security

Kin treats privacy as architecture. Household content is encrypted on the
device before it is stored or sent; the service holds identity and routing
metadata and encrypted envelopes, never household text or content keys.
There is no advertising, no analytics on household content and no telemetry.

The public, plain-language privacy policy is [`web/privacy.html`](web/privacy.html),
served at `/privacy.html` (for the hosted service,
<https://kin.journeytocode.io/privacy.html>) and linked from Household ›
Privacy & recovery. It is the policy URL for the Google Play listing; keep it
accurate to [PRIVACY](docs/PRIVACY.md) and [RETENTION](docs/RETENTION.md). A
self-hosted server serves the same page, which names the hosted service, so an
operator should publish their own.

To report a vulnerability, follow the [security policy](SECURITY.md). Please
do not open a public issue for one.

## AI usage

AI-assisted development tools were used throughout: brainstorming, product
planning, architecture exploration, documentation, implementation support,
debugging and testing. Kin itself has no AI runtime and no analytics, and
household data is never sent to an AI service. When sync is turned on, the
service receives encrypted event envelopes and limited routing metadata, never
plaintext household content or content keys.

## Contributing and community

Contributions are welcome, from a typo to a feature. Read
[CONTRIBUTING](CONTRIBUTING.md) for how to set up, what a good change looks
like and how a pull request is checked. The project follows a
[Code of Conduct](CODE_OF_CONDUCT.md); [SUPPORT](SUPPORT.md) says where to ask
questions.

Because Kin is nested in the ZTM Build Fest repository, its community files
and issue templates live in `projects/kin/` and `projects/kin/.github/`.
GitHub does not apply nested templates automatically; see
[GITHUB-COMMUNITY](docs/GITHUB-COMMUNITY.md).

## License

Kin is available under the [MIT License](LICENSE).

## Release history

Every release is tagged `kin-vX.Y.Z` in this repository. The
[changelog](CHANGELOG.md) has the detail; the lines so far:

- **v1.6.0 — Kin for Everyone** (2026-10-21): easy mode, Help on every screen,
  household features an admin can switch off, reports and suggestions from
  inside the app, setting Kin up for someone else, and the Android app.
- **v1.5.0 — One Account and Private Spaces** (2026-10-21): username and
  password, passkey and backup code, new-device sign-in, the journal, Just for
  me, and reminders and settings that follow each member.
- **v1.4.0 — Fridge, Meals and Household Helpers** (2026-10-20): the fridge,
  Meals, Simple view, Talk later, undo and redo, share into Kin, shopping mode,
  store sections, list import, This week, the sitter page and taking turns.
- **v1.3.0 — Member Names and Clearer Setup** (2026-10-19).
- **v1.2.0 — Household Chat** (2026-10-19): one chat room with receipts,
  replies, reactions, polls and voice messages.
- **v1.1.0 to v1.1.2 — Connected Household Devices** (2026-10-18): device
  names, installed-app identity, push notifications, the service sandbox and
  QR pairing.
- **v1.0.0 — Stable Kin Platform** (2026-10-17): the first stable release,
  freezing the storage, sync, export and server formats.
- **v0.1.0 to v0.47.0** (September and October 2026): from the first
  implementation through encrypted sync, the durable service, recovery,
  the workspace UX and more than thirty capability lines. v0.21 to v0.47 were
  never tagged on their own and shipped in v1.0.0.
- **v0.0.1 to v0.0.12**: planning and documentation only.
