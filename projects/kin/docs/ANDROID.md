# Kin's Android app (Google Play)

Kin on Google Play is a **Trusted Web Activity**: a small Android app that
opens `https://kin.journeytocode.io` in the user's browser (usually Chrome),
full-screen, with no address bar. It contains no Kin code. Why, and what it
may depend on, is [ADR 0020](decisions/0020-google-play-twa.md). This page is
how to build it, version it, sign it, link it to the site, and check it on a
phone (epic #527: #530, #535, #536, #537).

Self-hosted households don't use the Play app; they install Kin from their own
server's address in the browser.

## What's in `android/`

| Path | What it is |
| --- | --- |
| `gradle.properties` | **The one place** for the package name (`kinPackage=kin.app`), the origin (`kinHost`) and Play's `kinVersionCode`. |
| `settings.gradle`, `build.gradle` | Gradle project; Android Gradle Plugin 8.9.1. |
| `app/build.gradle` | The app: API 36, minimum API 24, `androidbrowserhelper` 2.7.4, release signing from an untracked file. Reads `../web/manifest.webmanifest` and `../package.json`. |
| `app/src/main/AndroidManifest.xml` | The launcher activity, links to the origin, share target, shortcuts, notification delegation, splash, Custom Tab fallback. |
| `app/src/main/res/` | Icons, splash and notification icon (drawn by `scripts/render-icons.mjs`), the adaptive icon, the splash file-provider paths. |

Derived at build time, never edited by hand:

- **Names and colours** from the web manifest: the app is "Kin — Household
  coordination", the launcher label "Kin", status and navigation bars
  `theme_color` (#684033), splash background `background_color` (#f5f1e9).
- **Share target** from the web manifest's `share_target`: Android's share
  sheet offers Kin for text, links, images and PDFs (one or several), and the
  browser POSTs them to `https://kin.journeytocode.io/share` as multipart form
  data, exactly as for the installed web app (#389). Android sends a shared
  link as text, so it arrives in `text`.
- **Shortcuts** (`res/xml/shortcuts.xml`, generated into the build directory):
  the first four of the web manifest's shortcuts, in its order (Add to
  shopping, Add a task, New journal entry, This week). Launchers show four, so
  reorder the web manifest to change which four.
- **Asset statement**: the app's half of Digital Asset Links, for the origin.
- **Version name** from `package.json`.

Shortcuts, names, colours and the share target are compiled into the app:
changing them in the web manifest reaches the Play app only with the next Play
release. Everything else about Kin reaches it at once.

Pictures: `node scripts/render-icons.mjs` writes the launcher icons (legacy
48 dp tile, and the adaptive 108 dp foreground on the tile colour, which is
also the Android 13 themed icon), the 128 dp splash, the 24 dp notification
icon and a 48 dp icon for every shortcut, at all five densities;
`--check` (and CI) fails when a committed PNG differs from what it draws.

## Building locally

You need JDK 17 or newer, the Android SDK with platform 36 (Android Studio, or
the command-line tools), and Gradle 8.11.1 or newer. Point Gradle at the SDK
with `ANDROID_HOME`, or an untracked `android/local.properties` containing
`sdk.dir=/path/to/sdk`.

No Gradle wrapper is committed (it would be a binary jar). Either use an
installed Gradle:

```sh
cd projects/kin/android
gradle assembleDebug          # app/build/outputs/apk/debug/app-debug.apk
gradle bundleDebug            # app/build/outputs/bundle/debug/app-debug.aab
```

or create the wrapper once (it's ignored) and use it from then on:

```sh
gradle wrapper --gradle-version 8.14.3
./gradlew assembleDebug
```

Install a debug build with `adb install -r app/build/outputs/apk/debug/app-debug.apk`.
A debug build is signed with your machine's debug key, which isn't in
`assetlinks.json`, so it opens Kin **with** an address bar. To see it
full-screen while testing, either add your debug key's fingerprint to a test
deployment's `KIN_ANDROID_CERT_SHA256`, or tell Chrome to skip the check for
this origin: enable `chrome://flags/#enable-command-line-on-non-rooted-devices`,
then

```sh
adb shell "echo '_ --disable-digital-asset-link-verification-for-url=\"https://kin.journeytocode.io\"' > /data/local/tmp/chrome-command-line"
```

and restart Chrome. Undo it with `adb shell rm /data/local/tmp/chrome-command-line`.

Check a built APK against Kin's files (package, origin, version, share target,
shortcuts, asset statement, notification delegation, no INTERNET permission):

```sh
node scripts/check-android-app.mjs android/app/build/outputs/apk/debug/app-debug.apk
```

It needs the SDK's `apkanalyzer` (`APKANALYZER`, or `ANDROID_HOME`).

## Versioning

- **`versionName`** is Kin's version from `package.json` when the app is
  built (for example `1.5.0`). It tells testers which Kin was current; the
  site may be newer, since web updates don't need a Play release.
- **`versionCode`** is `kinVersionCode` in `android/gradle.properties`, a
  counter: add one for every bundle uploaded to Play, in the same commit as
  the change it ships. Never reuse or lower it, even for a build Play
  rejected. Start at 1.
- A Play release is needed only for wrapper changes: anything in `android/`,
  the shortcuts, names, colours or share target in the web manifest, the icon
  geometry, the library version, or the yearly target-API update (Play
  requires a recent `targetSdk` for every update: raise `compileSdk` and
  `targetSdk` together when it does).

## Signing

Play App Signing is **on** (ADR 0020): Google keeps the app signing key; the
owner keeps an **upload key** that signs what is uploaded. Only the owner
uses the upload key. It never goes into the repository, CI, an issue or a chat.

### 1. Create the upload key (once)

Outside the repository, for example in a private folder in your home
directory:

```sh
keytool -genkeypair -v \
  -storetype PKCS12 \
  -keystore kin-upload.keystore \
  -alias kin-upload \
  -keyalg RSA -keysize 4096 \
  -validity 10000 \
  -dname "CN=Kin upload key"
```

`keytool` (part of the JDK) asks for a password. Make it long and random, and
store it in your password manager before anything else. A PKCS12 keystore
uses the same password for the store and the key. 10,000 days is about 27
years; Android's guidance is at least 25.

### 2. Keep it safe

- The keystore file: in a private folder outside any repository and outside
  folders that sync to shared places, **plus an offline backup** (for
  example an encrypted USB drive kept somewhere safe).
- The password: in your password manager, with a note of the alias
  (`kin-upload`) and where the file and its backup are.
- The ignore rules in `projects/kin/.gitignore` (`*.jks`, `*.keystore`,
  `keystore.properties`) are a safety net, not a place to keep it.

### 3. Tell the build where it is

Create `projects/kin/android/keystore.properties` (ignored, never committed):

```properties
storeFile=/home/you/private/kin-upload.keystore
storePassword=…
keyAlias=kin-upload
keyPassword=…
```

or set `KIN_ANDROID_KEYSTORE`, `KIN_ANDROID_KEYSTORE_PASSWORD`,
`KIN_ANDROID_KEY_ALIAS` and `KIN_ANDROID_KEY_PASSWORD` in the shell instead.
Then one command builds the signed bundle:

```sh
cd projects/kin/android && gradle bundleRelease
# app/build/outputs/bundle/release/app-release.aab
```

Without the key, debug builds still work and a release build stops with an
explanation.

### 4. First upload: enrol in Play App Signing

In Play Console, create the app, then upload `app-release.aab` to a testing
track (internal or closed). Accept **Play App Signing** with a Google-generated
app signing key when Console offers it. From then on, upload bundles signed
with the upload key; Google re-signs them.

### 5. The two fingerprints

- **App signing key** (what users install): Play Console → your app → Test and
  release → App integrity → Play app signing → *App signing key
  certificate* → SHA-256. Console's same page also shows a ready Digital
  Asset Links snippet.
- **Upload key**: the same page (*Upload key certificate*), or locally:

  ```sh
  keytool -list -v -keystore kin-upload.keystore -alias kin-upload
  ```

  and copy the `SHA256:` line.

Fingerprints are public (they identify a certificate, not the key), but they
are deployment configuration: keep them in the server's environment, not in
this repository.

### 6. Link the site

On the server for `kin.journeytocode.io`, set

```sh
KIN_ANDROID_PACKAGE=kin.app
KIN_ANDROID_CERT_SHA256=<app signing SHA-256>,<upload SHA-256>
```

(`AA:BB:…`, 32 pairs each, comma-separated; the upload one is optional and
only lets a release build you signed yourself open full-screen). Restart, then
check:

```sh
curl https://kin.journeytocode.io/.well-known/assetlinks.json
```

and Google's tester:
`https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://kin.journeytocode.io&relation=delegate_permission/common.handle_all_urls`.
A wrong or missing fingerprint doesn't break the app; it shows an address bar.

### Lost upload key, or it leaked

Because Google holds the app signing key, the app can continue:

1. Create a new upload key as in step 1 (new file, new password).
2. Export its certificate:
   `keytool -export -rfc -keystore kin-upload-2.keystore -alias kin-upload -file upload_certificate.pem`
3. Play Console → App integrity → Play app signing → **Request upload key
   reset**, and attach `upload_certificate.pem`. Google confirms by email;
   the new key works once they've processed it (allow a few days).
4. Replace the old upload fingerprint in `KIN_ANDROID_CERT_SHA256` with the
   new one (the app signing fingerprint doesn't change), and update
   `keystore.properties`.

If the key leaked, also say so in the reset request.

## CI

The Kin verification workflow's `android` job (Linux) installs Java 17 and
Gradle 8.14.3, checks the Android pictures against the renderer, builds an
**unsigned debug** APK and App Bundle, checks the APK with
`scripts/check-android-app.mjs`, and keeps both as the `kin-android-debug`
artifact for 14 days. It holds no key and never builds a release; signed
bundles are built by the owner (above).

**Required or not.** No other job waits for `android`, and the web
verification jobs don't depend on it: the web app ships whatever happens to
the wrapper, and the wrapper's build pulls the Android Gradle Plugin and
`androidbrowserhelper` from Google's Maven repository, whose outages shouldn't
block web releases. It runs on every Kin pull request, so a red `android`
check is visible before merging; treat it as blocking for any change to
`android/`, the web manifest or the icons. Make it a required status check in
branch protection once the Play app is in production.

`node scripts/verify.mjs` (on any machine) runs `scripts/android-app.test.mjs`,
which needs no SDK: the package and origin are written only in
`gradle.properties`, the manifest's filters and fallback, the shortcuts and
pictures, and that no key, password or fingerprint is in `android/`.

## Checking on a phone (#537)

The owner checks a build on a physical Android phone with Chrome, before the
first production release and after any wrapper change. Use a build that can
pass Asset Links: the Play-delivered build from a testing track (its
fingerprint is the app signing key's), or a debug build with Chrome's check
disabled as above. Record the results below.

- [ ] **No address bar**: the app opens Kin full-screen; the status bar is
      Kin's brown; the splash shows the Kin tile on cream, then Kin.
- [ ] **Share into Kin**: from Photos, share one image, then several; from a
      PDF viewer, a PDF; from Chrome, a page link; from Notes, some text.
      Kin opens its share screen with what was shared, and you can choose
      where it goes.
- [ ] **Shortcuts**: long-press the icon; the four shortcuts appear with their
      icons and each opens the right place (shopping add, quick add, a new
      journal entry, This week). Pin one to the home screen and use it.
- [ ] **Notifications**: turn on notifications in Kin; Android 13+ asks for
      permission once; a change from another member shows a notification
      under the Kin app (not under Chrome) with the K icon, and tapping it
      opens Kin.
- [ ] **Passkey sign-in**: unlock or sign in with a passkey (fingerprint,
      face or screen lock) inside the app.
- [ ] **Data shared with Chrome**: open `https://kin.journeytocode.io` in
      Chrome on the same phone; it's the same household, already set up, with
      the same lock. Clearing Kin's site data in Chrome clears it in the app
      too.
- [ ] **Links**: tapping a `https://kin.journeytocode.io` link in another app
      opens it in the Kin app.
- [ ] **Fallback** (optional): with Chrome disabled and a browser that has no
      TWA support as default, Kin opens in a Custom Tab with an address bar.

| Date | Phone and Android version | Browser and version | Build (versionCode, track) | Result and notes |
| --- | --- | --- | --- | --- |
| | | | | |
