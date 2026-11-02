# Kin documentation

A map of what is in this folder and where to start. Documents marked
*contract* are kept in step with the code (some by CI tests); documents marked
*record* describe what was verified when, and are not updated afterwards.

## Start here

| If you want to… | Read |
| --- | --- |
| Run Kin on your machine | [the README](../README.md#run-kin-locally) |
| Run Kin for your own household on a server | [SELF-HOSTING](SELF-HOSTING.md) |
| Change the code | [DEVELOPMENT](DEVELOPMENT.md), [TESTING](TESTING.md), [CODE-STYLE](CODE-STYLE.md), then [CONTRIBUTING](../CONTRIBUTING.md) |
| Understand what Kin is for | [PRODUCT](PRODUCT.md), [PRINCIPLES](PRINCIPLES.md), [UX](UX.md) |
| Understand how it is built | [ARCHITECTURE](ARCHITECTURE.md), then the contracts below |
| Know what it protects and what it doesn't | [PRIVACY](PRIVACY.md), [THREAT-MODEL](THREAT-MODEL.md), [the security policy](../SECURITY.md) |
| Work with an AI coding agent on Kin | [AGENTS.md](../AGENTS.md) |

## Product

- [PRODUCT](PRODUCT.md): vision, audience and the long-term product areas.
- [PRINCIPLES](PRINCIPLES.md): the daily-use principle and the non-goals (no
  blame, scoring, surveillance or gamification).
- [UX](UX.md): how Kin feels and behaves, screen by screen. Long; use its
  table of contents.
- [WORKSPACE-UX](WORKSPACE-UX.md): the five-destination workspace, routes and
  the item detail view (*contract*, asserted by the workspace browser suite).
- [ACCESSIBILITY](ACCESSIBILITY.md): the accessibility contract and what the
  browser gate checks.
- [PERSONAL-APPEARANCE](PERSONAL-APPEARANCE.md) and
  [HOUSEHOLD-IDENTITY-DEFAULTS](HOUSEHOLD-IDENTITY-DEFAULTS.md): colours,
  text size, easy mode and the household's name and icon.
- Checklists for real devices: [MOBILE-CHECKLIST](MOBILE-CHECKLIST.md),
  [KITCHEN-DISPLAY-CHECKLIST](KITCHEN-DISPLAY-CHECKLIST.md),
  [QR-ACCEPTANCE](QR-ACCEPTANCE.md),
  [IDENTITY-PAIRING-ACCEPTANCE](IDENTITY-PAIRING-ACCEPTANCE.md).
- [DAILY-UX-BASELINE](DAILY-UX-BASELINE.md) and
  [DAILY-UX-HARDENING](DAILY-UX-HARDENING.md): what the daily-use browser
  suites cover (*record*).

## Architecture and contracts

- [ARCHITECTURE](ARCHITECTURE.md): Rust/WASM engine, Web Components, the
  event log, the service. Read first.
- [DOMAIN](DOMAIN.md), [DATA-MODEL](DATA-MODEL.md), [EVENTS](EVENTS.md),
  [STATE](STATE.md), [LIFECYCLES](LIFECYCLES.md): the household domain, its
  events and how state is replayed from them (*contract*).
- [ABI](ABI.md): the manual JavaScript/WASM boundary (*contract*).
- [STORAGE](STORAGE.md): the IndexedDB stores and the key database (*contract*).
- [COMPONENTS](COMPONENTS.md): the Web Component contract.
- [IMPLEMENTATION](IMPLEMENTATION.md): the source layout and who owns what.
- [SYNC](SYNC.md), [PAIRING](PAIRING.md), [IDENTITY](IDENTITY.md),
  [PUSH](PUSH.md): devices, accounts, the encrypted relay and notifications
  (*contract*).
- [CRYPTOGRAPHY](CRYPTOGRAPHY.md), [ROOT-ROTATION](ROOT-ROTATION.md),
  [RECOVERY](RECOVERY.md): keys, rotation and recovery (*contract*).
- [VERSIONING](VERSIONING.md), [V1.0-COMPATIBILITY](V1.0-COMPATIBILITY.md),
  [MIGRATIONS](MIGRATIONS.md): the independent version axes and the v1.0
  promise that every v1.x release keeps reading v1.0 data. A CI test keeps
  V1.0-COMPATIBILITY in step with the code.
- [PORTABILITY](PORTABILITY.md), [RETENTION](RETENTION.md),
  [ATTACHMENT-ARCHIVE-LIMITS](ATTACHMENT-ARCHIVE-LIMITS.md): export, import,
  deletion and the bounded archive format.
- [TEST-VECTORS](TEST-VECTORS.md): canonical byte-level vectors the Rust and
  JavaScript tests share.
- [decisions/](decisions/): architecture decision records (ADRs), numbered and
  accepted. New hard-to-reverse decisions get a new record here.

## Privacy, security and operations

- [PRIVACY](PRIVACY.md): what is stored where, what the service can see, and
  the public policy (`web/privacy.html`).
- [THREAT-MODEL](THREAT-MODEL.md): what Kin protects against and the
  [known limitations](THREAT-MODEL.md#known-limitations-at-v10).
- [SELF-HOSTING](SELF-HOSTING.md): running the service yourself, every
  setting, backups and restore, reverse proxies.
- [HOME-SERVER](HOME-SERVER.md): Kin at home, building the one-file home
  server, running it, setting it up with the control panel, installing it
  as a service and the container image
  ([ADR 0025](decisions/0025-kin-at-home.md)).
- [HOME-CERTIFICATES](HOME-CERTIFICATES.md): the dependency-free ACME client
  for a Kin at home server's certificates (built and tested; not yet wired
  into a running server, [ADR 0025](decisions/0025-kin-at-home.md)).
- [DEBUGGING](DEBUGGING.md): privacy-safe diagnostics.
- [ANDROID](ANDROID.md), [PLAY-LISTING](PLAY-LISTING.md),
  [PLAY-RELEASE](PLAY-RELEASE.md): the Google Play app.
- [maintenance/](maintenance/): operator procedures.

## Process

- [DEVELOPMENT](DEVELOPMENT.md): tools, the service sandbox, data, icons.
- [TESTING](TESTING.md): the verification gate, the browser suites, flakes.
- [CODE-STYLE](CODE-STYLE.md): conventions for Rust, JavaScript and CSS.
- [RELEASES](RELEASES.md): how a release is cut and tagged.
- [ROADMAP](ROADMAP.md): how Kin got to v1.6 and where work is tracked now.
- [GITHUB-COMMUNITY](GITHUB-COMMUNITY.md): the community files and the
  monorepo limitation.
- [ci/](ci/): the reference copy of the verification workflow.

## Records

- [audits/](audits/): release acceptance matrices, trust audits, the v1.0
  reality check and tester guide (*record*).
- [experiments/](experiments/): design experiments that informed a feature.
- [planning/](planning/README.md): the release contracts and daily plans from
  v0.1 through the October 2026 push to v1.0 (*record*). Historical only.
