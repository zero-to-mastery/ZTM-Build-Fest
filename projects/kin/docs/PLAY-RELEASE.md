# Releasing Kin on Google Play

**Status:** Runbook, 2026-10-21 (epic #527, story #542 task #545). Kin is not
on Google Play yet. The steps marked **Owner** need the owner's Google account,
payment or judgement and can't be done from the repository: developer account
(#539), testers (#543) and submission (#544). Everything else is prepared
here and in [PLAY-LISTING](PLAY-LISTING.md).

Decisions this runbook assumes (owner, #527):

| Decision | Value |
| --- | --- |
| Production origin | `https://kin.journeytocode.io` (one origin per Play app; self-hosted households keep using the web app) |
| Package name | `kin.app` (permanent once the app is created; see PLAY-LISTING "Uncertainties" 6) |
| Play App Signing | **On**: Google holds the app signing key; the owner keeps only an upload key |
| Android wrapper | Trusted Web Activity in `android/`, built per [ANDROID](ANDROID.md); decisions in [ADR 0020](decisions/0020-google-play-twa.md) |

How Play fits Kin's own release process ([RELEASES](RELEASES.md)): a Kin
release (`kin-vX.Y.Z`) deploys the web app and server; the Play app opens that
site, so **most Kin releases need no Play release at all**. A Play release
ships a new Android wrapper, and has its own version code.

## 1. One-time setup

Do these in order. Record the date of each in the tracking issue.

### 1.1 Developer account and identity (#539) — Owner

- [ ] Sign in to <https://play.google.com/console> with the Google account
  that will own Kin long-term (not a personal account you might lose).
- [ ] Choose the account type. **Personal** is simplest; an **organization**
  account needs a D-U-N-S number but skips the closed-testing requirement in
  §2. Kin's plan assumes personal.
- [ ] Pay the one-time US$25 registration fee.
- [ ] Complete identity verification (legal name and address matching a
  government ID) and verify the contact email and phone number. Install the
  Play Console app on an Android phone if Google asks for device verification.
- [ ] Set the public **developer name** (shown on the listing) and the
  developer contact email. **PLACEHOLDER**: confirm the address in
  PLAY-LISTING ("Email") exists and is read.
- [ ] Wait for verification to finish (can take days) before creating the app.

### 1.2 Contacts the listing and policy name — Owner

- [ ] Create, or choose, the public support address for the listing
  (PLAY-LISTING uses the placeholder `support@journeytocode.io`).
- [ ] Create, or choose, the privacy contact. `web/privacy.html` uses the
  placeholder `privacy@journeytocode.io` (marked `data-placeholder` in the
  page). If it changes, edit the page and `server/privacy-page.test.mjs`.
- [ ] Decide how long service backups are kept and add it to the privacy
  policy's "How long things are kept" (PLAY-LISTING "Uncertainties" 4).

### 1.3 Create the app

- [ ] Play Console → **Create app**: name `Kin: Private Household App`
  (PLAY-LISTING), default language English (United States), **App**,
  **Free**, accept the declarations.
- [ ] Build the first signed bundle per [ANDROID](ANDROID.md) with package
  `kin.app`, and upload it to an internal or closed track (§2). The package
  name is fixed by the first upload and can never change.
- [ ] **Upload key**: create it and keep it safe exactly as
  [ANDROID](ANDROID.md#signing) "Signing" steps 1–3 say (outside the
  repository and CI, password in a password manager, offline backup).
- [ ] **Play App Signing**: accept Google-managed signing when the first
  bundle is uploaded (ANDROID "Signing" step 4). A lost or leaked upload key
  is recoverable through an upload key reset (ANDROID "Lost upload key, or
  it leaked").

### 1.4 Link the app and the site (asset links)

Android shows Kin without an address bar only when the site vouches for the
app ([README](../README.md) "Linking a Google Play app", `server/asset-links.mjs`).

- [ ] Copy the two SHA-256 fingerprints (app signing key and upload key) as
  [ANDROID](ANDROID.md#5-the-two-fingerprints) "The two fingerprints"
  describes.
- [ ] On the production server set `KIN_ANDROID_PACKAGE=kin.app` and
  `KIN_ANDROID_CERT_SHA256=<app signing SHA-256>,<upload SHA-256>`, restart,
  and check `/.well-known/assetlinks.json` and Google's statement tester
  (ANDROID "Link the site"). A half or malformed setting stops the server
  with an explanation; a wrong fingerprint only brings back the address bar.
- [ ] Install from the test track on a phone with Chrome: no address bar. If
  the bar shows, the fingerprint or package is wrong, or Chrome cached an old
  answer: fix, then clear Chrome's data for the app or reinstall.

### 1.5 App content (Policy → App content)

Answers are drafted in [PLAY-LISTING](PLAY-LISTING.md); enter them and keep
screenshots of what was submitted.

- [ ] **Privacy policy**: `https://kin.journeytocode.io/privacy.html` (check
  it loads, signed out, on a phone).
- [ ] **App access**: the instructions in PLAY-LISTING ("Other Play Console
  declarations").
- [ ] **Ads**: No ads.
- [ ] **Content rating**: the IARC questionnaire draft.
- [ ] **Target audience and content**: Owner decision; PLAY-LISTING
  recommends 18 and over (Families policy implications explained there).
- [ ] **Data safety**: the mapping, after reviewing its "Uncertainties".
  Include the **delete account URL**
  `https://kin.journeytocode.io/privacy.html#delete`.
- [ ] Government, financial, health and news declarations: No. Advertising
  ID: No.

### 1.6 Store listing (Grow → Store presence → Main store listing)

- [ ] Name, short and full description from PLAY-LISTING.
- [ ] App icon: `web/icons/icon-maskable-512.png` (full-bleed; Play applies the rounded shape).
- [ ] Feature graphic: `play/feature-graphic.png`.
- [ ] Screenshots: run **Kin verification → Run workflow** on the release
  commit, download **kin-play-screenshots**, look at every image, then upload
  `phone-*` (phone), `tablet7-*` (7-inch) and `tablet10-*` (10-inch).
- [ ] Category, tags, contact email, website (PLAY-LISTING).

## 2. Closed test (#543) — Owner

A **personal** developer account created after November 2023 must run a
closed test with **at least 12 testers opted in for at least 14 consecutive
days** before it can apply for production. Days only count while 12 or more
are opted in, so recruit more.

- [ ] Create a **Closed testing** track; upload the bundle; complete the
  release with short notes.
- [ ] Add testers by email list or a Google Group (a group is easier to grow).
  Each tester needs a Google account on an Android phone with Chrome.
- [ ] Recruit **15–20** people: household, friends, Build Fest and Chingu or
  Code the Dream communities. Tell them what Kin is, that it's a test, that
  they need to stay opted in for at least 14 days, and that they should use
  made-up or ordinary household things, not secrets.
- [ ] Send each tester the **opt-in link** (Testers tab), then the Play
  install link. Opting in alone doesn't count until they accept; installing
  confirms it works.
- [ ] Track in a private sheet (not in this repository): tester alias, date
  opted in, device and Android version, installed yes/no, still opted in,
  feedback given. Check the Play Console tester count every few days; if it
  drops toward 12, recruit before it does.
- [ ] Give testers a few things to try: create or join a household, add to
  Shopping from the home-screen shortcut, share a photo into Kin from the
  gallery, turn on notifications and receive one, add a passkey and sign in
  with it, write a journal entry.
- [ ] Feedback: testers write to the support address or use Play's private
  feedback; triage each report into a GitHub issue (label it, link it from
  the epic, no personal data). Fix what blocks release; ship fixes as normal
  Kin releases (web) or a new bundle (wrapper).
- [ ] After 14 consecutive days with 12+ opted in, Play Console offers
  **Apply for production**. Answer its questions from the sheet: how testers
  were recruited, how engaged they were, what feedback came in and what
  changed. Keep the answers factual.

## 3. Production submission (#544) — Owner

- [ ] Every item in §1 complete; Play Console's **Dashboard** shows no open
  tasks.
- [ ] Kin verification green on the commit being released, and the bundle
  built from that commit per ANDROID.
- [ ] **Production → Create new release**: upload the bundle (or promote the
  closed-test release), write release notes (plain, a few lines), choose
  countries.
- [ ] Start with a **staged rollout** (for example 20%), then 50% and 100%
  over a few days while watching Play Console's Android vitals and new
  reviews.
- [ ] **Send for review**; answer any review questions from PLAY-LISTING and
  this runbook. Review can take several days for a new app.
- [ ] When live: add the Play Store link to [README](../README.md), Kin's
  website, and the release's CHANGELOG entry; close #544 and the epic.

## 4. Later releases

### Web release or Play release?

| Change | What ships |
| --- | --- |
| Anything in `web/` or `server/` (features, fixes, styles, the service worker, the privacy policy) | **Web only**: deploy the Kin release as usual. The Play app picks it up the next time it opens Kin. |
| The web manifest's name, colours, shortcuts or share target, or the icon geometry in `scripts/render-icons.mjs` | Web, **and** a Play release: the wrapper copies these at build time (ANDROID), so Android users keep the old ones until the bundle is rebuilt. |
| The wrapper itself: anything in `android/`, the yearly target-API update Play requires, the androidbrowserhelper version, notification delegation, splash screen, fallback behaviour | **Play release** (ANDROID "Versioning"). |
| Package name or production origin | Not a release: a new app. Avoid. |
| Signing (upload key) | Play Console's upload key reset; no new app. |
| What the service collects or keeps | Web release **plus** updated privacy policy, PLAY-LISTING, and Data safety form in Play Console **before** the change ships. |

### Shipping a Play release

- [ ] Add one to `kinVersionCode` in `android/gradle.properties` (a counter
  that must increase with every upload, never reused, independent of Kin's
  semver), in the same commit as the change it ships; the version name comes
  from `package.json` ([ANDROID](ANDROID.md#versioning) "Versioning").
- [ ] Build the signed bundle (`gradle bundleRelease`, ANDROID "Signing"
  step 3); Kin verification's `android` job must be green on that commit.
- [ ] Upload to **closed testing** first; install it on a phone; check no
  address bar, shortcuts, sharing in, notifications and passkey sign-in.
- [ ] Promote to **Production** with a staged rollout (20% → 50% → 100%),
  watching vitals and reviews between steps.
- [ ] Note the version code and Kin version in CHANGELOG under the release.

## 5. Rollback

- **A bad web release** (most problems): redeploy the previous Kin release on
  the server. The Play app follows the site, so no Play action is needed.
  Mind the server's own rollback limits (RELEASES: schema migrations and
  pre-upgrade backups).
- **A bad Play release during a staged rollout**: Play Console → Production →
  **Halt rollout**. Users who haven't updated stay on the previous bundle.
- **A bad Play release already at 100%**: Play can't install a lower version
  code. Rebuild the last good wrapper source with a **higher** version code
  and release it.
- **Address bar suddenly showing**: asset links broke (server env lost, a
  changed fingerprint, the file unreachable). Check
  `/.well-known/assetlinks.json`, restore `KIN_ANDROID_PACKAGE` and
  `KIN_ANDROID_CERT_SHA256`, restart. Kin keeps working meanwhile, just with
  the bar.
- **Data safety or policy mistake**: correct the policy page (a web release)
  and the Play Console form the same day; Play may otherwise flag the app.
