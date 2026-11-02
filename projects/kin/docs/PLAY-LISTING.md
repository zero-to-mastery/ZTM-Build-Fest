# Google Play listing and Data safety

**Status:** Draft for Kin v1.5.0, 2026-10-21 (epic #527, story #538: tasks
#540 listing assets and #541 privacy policy and Data safety). Nothing here is
submitted yet: the owner enters it in Play Console during the one-time setup
in [PLAY-RELEASE](PLAY-RELEASE.md). Values marked **PLACEHOLDER** must be
confirmed or replaced first; **Owner decision** marks a choice this document
recommends but cannot make.

The Play app is a Trusted Web Activity: a thin Android app, package
`kin.app`, that opens <https://kin.journeytocode.io> full-screen in Chrome.
Everything below describes that service and the web app it opens, because
that is all the Play app does. Keep this document, the public
[privacy policy](../web/privacy.html), [PRIVACY](PRIVACY.md) and the
[threat model](THREAT-MODEL.md) in agreement: when a feature changes what
leaves the device, update all four, then the Play Console answers.

## Store listing (#540)

| Field | Value | Limit |
| --- | --- | --- |
| App name | `Kin: Private Household App` | 26 / 30 |
| Short description | `Lists, plans and chat for your household, end-to-end encrypted. No ads.` | 71 / 80 |
| Full description | [below](#full-description) | about 2,200 / 4,000 |
| App or game | App | |
| Category | **Productivity** (Owner decision; alternatives: *House & Home*, *Parenting*) | |
| Tags | Up to five from Play's list, such as *Family*, *To-do list*, *Shopping list*, *Planner* (Owner decision: Play offers its own fixed list) | |
| Email (shown publicly) | **PLACEHOLDER** `support@journeytocode.io` | required |
| Website | `https://kin.journeytocode.io` | optional |
| Phone | none | optional |
| Privacy policy URL | `https://kin.journeytocode.io/privacy.html` | required |
| App icon | `web/icons/icon-maskable-512.png` (512 × 512, full-bleed square from `scripts/render-icons.mjs`; Play rounds the corners itself, so not `icon-512.png`, whose corners are already transparent) | 512 × 512, 32-bit PNG |
| Feature graphic | `play/feature-graphic.png` (1024 × 500, 24-bit) | 1024 × 500, no alpha |
| Phone screenshots | `phone-*.png` from the [screenshot job](#screenshots) (1080 × 1920) | 2–8, 9:16 or 16:9 |
| 7-inch tablet screenshots | `tablet7-*.png` (1080 × 1920) | up to 8 |
| 10-inch tablet screenshots | `tablet10-*.png` (2560 × 1440) | up to 8 |

Why this name: "Kin" alone is short and common, so the subtitle says what it
is. Play's metadata policy rules out claims like "best" or "#1", repeated
keywords and emoji in the name; "Private" is a description the product can
back up (end-to-end encryption, no ads or tracking), not a ranking. If the
owner prefers a calmer name, `Kin: Household Organizer` (24) also fits.

### Full description

Plain text; Play shows line breaks and keeps bullets as typed. Check the
count again after any edit (`node -e` with the text's `.length`).

```text
Kin is a calm, private place for the people you live with to keep track of the little things: what's needed, what's happening this week, who's picking up whom, and what can wait for a better moment to talk about.

What's in Kin
• Today: what matters to your household today, with routines like feeding the cat.
• Lists: To do, Shopping (with store sections and a shopping mode) and Staples you buy again and again.
• This week: seven days at a glance. Move plans to another day in one tap.
• Chat: one chat for your household, with photos, voice messages, replies and polls.
• Handoffs and Talk later: pass on what the next person needs to know, and save a topic for a better time.
• The family fridge, meals, notes, and a page for the babysitter.
• Your own journal and a Just for me list that only your devices can read.
• Reminders, home-screen shortcuts, sharing into Kin from other apps, and notifications that never say what's new.

Private by design
• What your household writes is encrypted on your device before it syncs. Kin's service stores it but can't read it.
• The service does see who is in your household, when and how much your devices sync, and your IP address while you're connected. The privacy policy explains exactly what it keeps and for how long.
• No ads. No tracking or analytics. Your information isn't sold or shared. Nothing you write is sent to an AI service.
• Works offline, and catches up when you're back online.

For the whole household
• Up to four adults, plus children and teens as Limited members, and babysitters or guests with access that ends when you say. A household admin decides who joins.
• Sign in with a username and password, then add a passkey so your face, fingerprint or screen lock opens Kin.
• Leave a household, remove a member or delete the whole household from inside the app.

Good to know
• Kin opens its web app, kin.journeytocode.io, full-screen through Chrome. Updates arrive without a new app version, and the same household works in any modern browser.
• Kin is open source (MIT) and was built for ZTM Build Fest. It hasn't had an independent security review.
• Kin helps a household coordinate. It doesn't judge, score or monitor anyone.
```

### Screenshots

`scripts/play-screenshots.mjs` takes them from the real app: it starts the
Kin server in-process with an in-memory database, opens headless Chrome, and
two made-up members (Robin creates "The Rivera house", Sam joins by
invitation, both with passwords) fill it with ordinary household things: plans
for today and the week, two routines, a shopping list, a short chat and two
journal entries. Then it captures, in light mode, one-time cards dismissed:

| Order | Screen | What it shows |
| --- | --- | --- |
| 1 | Today | Today's plans and routines |
| 2 | Shopping | The shared shopping list |
| 3 | This week | Seven days of plans |
| 4 | Chat | Sam and Robin's conversation |
| 5 | Journal | Robin's private journal |

at three sizes, each saved as a 24-bit PNG (Play refuses an alpha channel):

| Device | CSS viewport | Scale | File size | Files |
| --- | --- | --- | --- | --- |
| Phone | 360 × 640 | 3× | 1080 × 1920 | `phone-1-today.png` … `phone-5-journal.png` |
| 7-inch tablet | 720 × 1280 | 1.5× | 1080 × 1920 | `tablet7-*.png` (side-navigation layout) |
| 10-inch tablet | 1280 × 720 | 2× | 2560 × 1440 | `tablet10-*.png` |

To get them: GitHub → Actions → **Kin verification** → **Run workflow** on the
branch to capture. The `play-screenshots` job runs only for a manual run
(never on pull requests or pushes), after `verify-linux` builds the engine,
and uploads **kin-play-screenshots** (kept 30 days). Locally, with a built
engine (`./build-wasm.sh`, or `node scripts/fetch-wasm.mjs`) and Chrome or
Edge:

```sh
node scripts/play-screenshots.mjs "/path/to/chrome" [--out target/play-screenshots]
```

Look at every image before uploading: the dates are the day of the run, and
a one-time card the script didn't expect could slip in. All text is
invented; never capture a real household.

### Feature graphic

`play/feature-graphic.png` is drawn by `scripts/render-play-graphics.mjs`
from the app icon's geometry: the icon, the name "Kin", and the Today,
Shopping, This week, Chat and New journal entry shortcut icons, on Kin's page
colour, with nothing near the edges. Change the geometry, run the script,
commit the PNG; `scripts/render-play-graphics.test.mjs` fails if they drift.

## Data safety (#541)

Play's form asks what user data the app **collects** (sends off the device)
and **shares** (passes to a third party), why, and how it is protected. These
answers follow [PRIVACY](PRIVACY.md), [THREAT-MODEL](THREAT-MODEL.md)
("Metadata and anonymity", the account, private storage and chat sections),
[RETENTION](RETENTION.md) and [PUSH](PUSH.md), and the
[privacy policy](../web/privacy.html), which says the same in plain words.
They are deliberately conservative: where Play's definitions leave room, Kin
declares rather than omits. **Owner review needed** before submitting: Play's
help pages change, and the uncertainties are listed at the end.

### Overview questions

| Play question | Answer | Why |
| --- | --- | --- |
| Does your app collect or share any of the required user data types? | **Yes** | It collects account and device identifiers and a security log (below). |
| Is all of the user data collected by your app encrypted in transit? | **Yes** | The service is HTTPS only; the TLS proxy setup is in the README ("Running behind a TLS proxy"). Household content is also end-to-end encrypted. |
| Which account creation methods does your app support? | **Username and password**; and **OAuth / other**: none. (Passkeys are added after sign-up.) | ADR 0018; [IDENTITY](IDENTITY.md). |
| Do you provide a way for users to request that their data is deleted? | **Yes** | In the app: Household → People & devices → **Leave household** (deletes the member's account), **Remove** a member, **Delete household**. On the web: <https://kin.journeytocode.io/privacy.html#delete>. [RETENTION](RETENTION.md). |
| Delete account URL (Play's account deletion requirement) | `https://kin.journeytocode.io/privacy.html#delete` | Describes the in-app steps and what is deleted and kept, and gives the contact for a member who can no longer sign in. |
| Can users request that some data be deleted without deleting their account? | **Yes** | Deleting a chat message for everyone removes its content from the service; removing a photo from a journal entry deletes its sealed blob; withdrawing the published household name and icon deletes that copy; turning notifications off deletes the push subscription. |
| Is your app's data safety reviewed by an independent security review (MASA)? | **No** | [PRIVACY](PRIVACY.md) "Claims boundary"; [SECURITY](../SECURITY.md). |
| Committed to Play Families policy? | Only if the owner chooses a child audience; see [Target audience](#target-audience-and-families-policy). | |

### Data types

"Collected" in Play's sense means sent off the device. "Optional" means a user
can use Kin without it being collected.

| Play category › type | Collected? | Shared? | Required or optional | Purposes | What it is, and why |
| --- | --- | --- | --- | --- | --- |
| Personal info › **User IDs** | **Yes** | No | Required | App functionality; Account management; Fraud prevention, security and compliance | The username a member chooses (not necessarily a real name; Kin has no email), and random household, member and device IDs. The service needs them to sign members in and route encrypted data. [PRIVACY](PRIVACY.md) "Username and password sign-in". |
| Personal info › Name | **No** | No | | | A member's display name is typed into an encrypted household event; the service never sees it. Device nicknames are encrypted too. |
| Personal info › Email, Phone, Address | **No** | No | | | Kin never asks for them. |
| Personal info › **Other info** | **Yes** (if used) | No | Optional | App functionality | Only if a household admin turns on "Show our name and icon on home screens": the household name, short name, description and icon are stored **unencrypted** to build the installed app's manifest. Off by default; withdrawing deletes it. [THREAT-MODEL](THREAT-MODEL.md) "A published install identity is not encrypted". Declared here rather than under user-generated content because it names the household. |
| Messages › Other in-app messages | **No** (end-to-end encrypted) | No | | | Chat is sealed on the device; the service stores ciphertext it can't read. See [Uncertainties](#uncertainties) 1. |
| Photos and videos; Audio (voice messages); Files and docs | **No** (end-to-end encrypted) | No | | | Chat and journal attachments, fridge drawings and item pictures are sealed per file on the device. Uncertainty 1. |
| App activity › Other user-generated content | **No** (end-to-end encrypted) | No | | | Lists, plans, routines, notes, handoffs, the journal, Just for me, reminders, settings. Uncertainty 1. |
| App activity › **Other actions** | **Yes** | No | Required | App functionality; Fraud prevention, security and compliance | The service's security log records account and device events (household created, member joined or removed, device added or revoked, new-device sign-in, password changed, passkey added), with times and IDs, no content; at most 10,000 rows across the service, purged with the household. [PRIVACY](PRIVACY.md), [RETENTION](RETENTION.md) "Security audit". |
| App activity › App interactions | **No** (Owner decision; see uncertainty 2) | No | | | The service sees when and how much each device syncs because it relays the ciphertext, but records no taps, screens, sessions or usage analytics. |
| App activity › In-app search history | **No** | No | | | Search runs on the device and is never sent. |
| Device or other IDs | **Yes** | No | Required | App functionality; Fraud prevention, security and compliance | Each device's random ID, its public signing and encryption keys, its automatic name ("Chrome on Android", from the browser's user agent), and, if notifications are on, its push subscription endpoint and keys. [IDENTITY](IDENTITY.md#device-names), [PUSH](PUSH.md). No advertising ID or hardware ID is used. |
| Location (approximate or precise) | **No** | No | | | Kin never asks for location. IP addresses are used only for rate limits, in memory (uncertainty 3). Photos are redrawn on the device, which drops location metadata. A reminder's time zone stays in the member's end-to-end encrypted private storage. |
| Financial info; Health and fitness; Contacts; Calendar; Web browsing; Installed apps | **No** | No | | | Not used. Calendar export writes an `.ics` file on the device; nothing is sent. |
| App info and performance (crash logs, diagnostics) | **No** | No | | | No crash reporting, analytics or diagnostics upload. The server's own operational logs carry no user content. |

**Data shared: none.** Kin passes nothing to third parties. The hosting
provider runs Kin's server for Kin (a service provider, which Play does not
count as sharing). If notifications are on, the browser's push service
(Firebase Cloud Messaging for Chrome) delivers a fixed, encrypted
"something is new" message to an endpoint that service created; it learns
when, not what.

### Uncertainties

The owner should check each against the current Play Console help ("Provide
information for Google Play's Data safety section") before submitting:

1. **End-to-end encrypted content.** Play's guidance has listed
   end-to-end-encrypted data (unreadable by anyone but sender and recipient)
   among things that need not be declared as collected. Kin's household
   content meets that description: the service holds ciphertext and no keys
   ([CRYPTOGRAPHY](CRYPTOGRAPHY.md)). But Kin has not had an independent
   review, and members' keys can be held in an account vault on the service,
   sealed under a key derived on the device ([ADR 0018](decisions/0018-account-key-vault.md)).
   If the owner prefers the most cautious reading, also declare Messages,
   Photos and videos, Audio, Files and docs and Other user-generated content
   as **collected, optional, App functionality, not shared**; the privacy
   policy already describes them either way. (This draft could not open
   Play's own help page while it was written; confirm the exemption's exact
   wording there.)
2. **App interactions.** Sync timing, counts and sizes are visible to the
   service (THREAT-MODEL "Metadata and anonymity") but are not recorded as
   usage data. If Play's reviewer reads "App interactions" broadly, declaring
   it (required, App functionality) is harmless.
3. **IP addresses.** Play has no IP-address data type. Kin keeps IP
   addresses only in memory for rate limits (reset on restart; never written
   to its database), which is close to Play's "ephemeral processing"
   exemption, though the windows last up to 15 minutes. The hosting
   provider's network logs may hold IP addresses; ask the provider how long.
4. **Server backups.** [RETENTION](RETENTION.md) says operator backups have
   no automatic expiry, so deleted data may survive in a backup. The privacy
   policy says so. The owner should set a backup retention period (for
   example 30 days) and then say it in the policy, which makes Play's
   deletion answers stronger.
5. **Members' shared contributions after leaving.** Leaving deletes the
   account, vault and private storage at once, but things the member added
   to shared lists and chat stay in the household's encrypted history until
   the household is deleted. Play allows keeping data for stated reasons; the
   policy states this one. Confirm the wording satisfies the account deletion
   requirement.
6. **Package name.** `kin.app` is valid, but Play package names are
   permanent and globally unique; if it is taken, choose another (such as
   `io.journeytocode.kin`) before creating the app, and update
   `KIN_ANDROID_PACKAGE`.

## Content rating questionnaire (draft)

Play uses the IARC questionnaire. Category: **Utility, Productivity,
Communication or Other** (not a game). Answers as of v1.5.0:

| Question area | Answer | Note |
| --- | --- | --- |
| Violence, blood, fear | No | |
| Sexuality, nudity | No | |
| Language (profanity) | No | Members can type anything in chat; see interaction below. |
| Controlled substances (drugs, alcohol, tobacco) | No | |
| Gambling, simulated gambling | No | |
| Crude humour | No | |
| Does the app let users interact or exchange content with each other? | **Yes** | Household chat (text, photos, files, voice), shared lists and the fridge, only between members an adult invited into the household. No public profiles, no strangers, no discovery. |
| Does the app share the user's current location with other users? | No | |
| Does the app allow purchases of digital goods? | No | Kin has no purchases. |
| Is the app a web browser or search engine, or does it give unrestricted internet access? | No | It opens only Kin's own site. Links in chat are shown as text. (Owner: confirm against the current UI before answering.) |
| Does the app contain content generated by AI? | No | |

Expected result: Everyone / PEGI 3 / USK 0 (or regional equivalents) with the
interactive element **Users Interact**. Answer honestly even if the result is
higher; it can be redone after any change.

## Target audience and Families policy

Kin households include children and teens as **Limited members**, invited by
an adult (HOUSEHOLD-IDENTITY-DEFAULTS). Play's "Target audience and content"
section asks which age groups the app targets, and **choosing any group under
13 brings the whole app under Play's Families policy**: it must meet COPPA
and similar laws (in the US, verifiable parental consent before collecting a
child's personal information, which includes a username and persistent
identifiers like device IDs), follow Families rules for every SDK and
permission, and can be reviewed against the Families requirements.

| Option | Target age groups | What it means |
| --- | --- | --- |
| **A (recommended)** | **18 and over** | Kin is set up and run by adults; children appear only as members of a household an adult created and controls. Answer "No" to "Could your store listing unintentionally appeal to children?" (the listing shows household logistics, no characters or games). The privacy policy already says Kin isn't designed for children to use on their own. Risk: if Google judges the app appeals to children it may ask for changes. |
| B | 13–15, 16–17 and 18+ | Teens are a realistic audience (Limited members). No Families policy, but Play's teen rules apply, and nothing in Kin is unsuitable. Reasonable if the owner wants teens to find and install it themselves; they still need an invitation. |
| C | Including under 13 | Families policy and COPPA: Kin would need a documented parental-consent step before a child's username and device IDs reach the service, a Families-compliant privacy section, and ongoing compliance. Not recommended until Kin has that flow. |

**Owner decision:** A, unless there is a reason to list for teens (B).
Whichever is chosen, keep the listing's text and graphics adult-oriented.

## Other Play Console declarations

| Section | Answer |
| --- | --- |
| Ads | **No, my app does not contain ads.** |
| App access | **All functionality is available without special access**, with instructions: "Open the app, choose *Start a new household*, enter any name, household name, username and a password of 10+ characters. Inviting a second member needs a second device or browser; this is optional." (Or provide a demo account if Play asks for one: **PLACEHOLDER**.) |
| Advertising ID | **No**. `android/app/src/main/AndroidManifest.xml` declares only `POST_NOTIFICATIONS` (no `AD_ID`); check the merged manifest of the release build too, since a library could add one ([ANDROID](ANDROID.md)). |
| Government app, financial features, health | No. |
| News app | No. |
| Data safety | As above. |
| Content rating | As above. |
| Target audience | As above. |
