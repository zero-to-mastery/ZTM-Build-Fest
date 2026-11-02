# ADR 0020 — Kin on Google Play as a Trusted Web Activity

Status: **Accepted** (#529, story #528, epic #527). The owner's decisions of
2026-10-21 are recorded below: the production origin, the package name and
Play App Signing. The Android project is in `android/` (#535, #536); how to
build, sign and check it is in [ANDROID](../ANDROID.md).

## Context

Many people look for apps in the Play Store and don't know how to install a
web app. A Play listing makes Kin easier to find for non-technical household
members (epic #527). Kin is a web app by design ([ADR 0007](0007-zero-runtime-frameworks.md),
[ADR 0006](0006-local-first.md)): its code, its storage and its passkeys live
in the browser, and the web code doesn't change for a store.

Android's way to publish a web app as an app is a **Trusted Web Activity**
(TWA): a small Android app that opens one website in the user's browser,
full-screen and without an address bar, once the site and the app prove they
belong together (Digital Asset Links). Bubblewrap and PWABuilder generate such
an app from a web manifest.

## Decision

### A Trusted Web Activity, not a native app or a WebView

The Play app is a TWA. It contains no Kin code: it opens Kin's site in the
browser that hosts TWAs (usually Chrome), which runs the same web app, the
same service worker and the same WebAuthn as the installed web app. A WebView
wrapper was rejected: it would have its own storage, no passkeys, and Kin's
security would then depend on the wrapper's code.

### One origin: `https://kin.journeytocode.io`

A TWA is tied to one origin, so the Play app opens exactly one Kin service:
**`https://kin.journeytocode.io`**. That origin serves
`/.well-known/assetlinks.json` (`KIN_ANDROID_PACKAGE`,
`KIN_ANDROID_CERT_SHA256`, #532, `server/asset-links.mjs`).

**Self-hosted households keep using the web app.** A household on its own
server installs Kin from its own address in the browser ("Install app" / "Add
to Home screen"), exactly as today. Per-household servers can't share one Play
app, and the Play app doesn't offer to switch servers. Nothing in Kin's web
code, data or protocols depends on the Play app.

### Package name: `kin.app`

The owner chose **`kin.app`**. Two things to know about it:

- **Permanent and globally unique.** Play never lets an app change its package
  name after the first upload, and no other app may ever use it.
- **A namespace the owner doesn't control.** By convention a package name is a
  reversed domain the publisher owns (`io.journeytocode.kin`); `kin.app`
  isn't one, so nothing stops another developer from having picked it first,
  in which case Play refuses the upload. The owner accepted this.

The package name is written in **one** place, `android/gradle.properties`
(`kinPackage`), so it can still change before the first upload; the
application ID, file-provider authority and shortcut targets are derived from
it, and a test fails if it appears anywhere else in `android/`. The Java code
namespace (`kin.twa`) is not the Play identity and can stay.

### Play App Signing: on

Google holds the **app signing key** and signs what Play delivers; the owner
keeps only an **upload key**, which signs the bundles uploaded to Play. A lost
upload key can be reset through Play support; a lost app signing key could
not be. `/.well-known/assetlinks.json` must list the **Play App Signing
certificate's** SHA-256 fingerprint (shown in Play Console after the first
upload) and may also list the upload key's (to test locally signed release
builds). Only the owner has the upload key and its password; they never enter
the repository or CI. See [ANDROID](../ANDROID.md#signing) for creating,
storing and recovering it.

### The dependency exception

Kin's rule is zero runtime dependencies (AGENTS.md "Dependency Policy",
[ADR 0007](0007-zero-runtime-frameworks.md)). The Android wrapper is an
exception, **scoped to `android/`**:

- **Google's `com.google.androidbrowserhelper:androidbrowserhelper`** (2.7.4,
  Apache-2.0), which brings `androidx.browser` and a few other AndroidX
  libraries. It launches the TWA, verifies the browser, hands over the splash
  screen, passes shared content to the share target, delegates notifications
  (including Android 13's notification permission) and falls back when no
  browser supports TWAs.
- **Gradle and the Android Gradle Plugin**, as build tooling only.

**Why.** Each of those is Android platform glue that must match what Chrome
expects across Android versions (the TWA service protocol, token storage for
the verified browser, notification delegation, share-target hand-over).
Hand-rolling them would mean re-implementing and maintaining Google's
library for no gain in Kin's privacy or security, which don't depend on it.
Bubblewrap itself was not adopted as a tool (it's a Node CLI with
dependencies); the project is written by hand to match what Bubblewrap
generates, and derives everything from Kin's own files.

**Boundary.** Nothing from the exception is part of Kin's web runtime, the
Rust engine, the server or their builds; `package.json` keeps no
dependencies, and the web app works without the Play app. The Android project
has no Java or Kotlin code of its own: its activities and service are the
library's classes, configured in `AndroidManifest.xml`. Updating the library
is a deliberate change (pinned version), recorded in the CHANGELOG.

### What comes from where

`android/app/build.gradle` reads `web/manifest.webmanifest` for the app's
names, theme and background colours, share target and shortcuts (the first
four: launchers show four), and `package.json` for the version name. The
icons, splash and notification icon are drawn by `scripts/render-icons.mjs`
from the same geometry as the web icons. A unit test and a CI check of the
built APK (`scripts/check-android-app.mjs`) compare the app with those files.

### Behaviour

- **Fallback.** With no browser that supports TWAs, the app opens Kin in a
  **Custom Tab** (with a URL bar), never a WebView. If Asset Links
  verification fails (wrong fingerprint, file missing), the TWA also shows a
  URL bar; nothing else changes.
- **Storage is the browser's.** Kin's IndexedDB, device keys, service worker,
  cookies and passkeys belong to the browser profile for the origin: the Play
  app and Chrome's tab or installed web app for `kin.journeytocode.io` are the
  same Kin, with the same household and lock. Clearing the site's data in
  Chrome clears it in the app; uninstalling the app doesn't by itself delete
  it.
- **Updates.** Web changes reach the Play app at once, as they reach the web
  app. A Play release is needed only for wrapper changes: the package's
  configuration, its icons, the shortcuts or share target compiled from the
  web manifest, the library version, or Play's yearly target-API requirement.
- **Target API 36** (Android 16), Play's requirement for new apps and updates
  in 2026; minimum Android 7.0 (API 24), the library's minimum.

## Consequences

- Play users get Kin without knowing what installing a web app means; their
  data, keys and protocols are the web app's.
- The owner must keep the upload key safe, keep `assetlinks.json` matching
  the Play App Signing certificate, and raise the target API each year.
- Kin's privacy claims don't change: the wrapper adds no analytics, no network
  access of its own (it has no INTERNET permission) and no storage of
  household data. THREAT-MODEL "The Google Play app" records what it does
  add.
- A household that moves to its own server leaves the Play app behind and
  uses the web app there.
