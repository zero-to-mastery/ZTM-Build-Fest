# Push notifications

**Shipped in:** v1.1.0 (#85). Off by default; each device turns it on itself.

A push tells a device that something is new in its household. It never says
what, who added it or how many, and Kin records nothing about whether it was
delivered, shown or tapped (no read receipts; [PRODUCT-BOUNDARIES](planning/PRODUCT-BOUNDARIES.md)).

## What a member sees

The section first explains that Kin notifies this device only about changes
from other active household members. Changes made on any device belonging to
the signed-in member are excluded by stable author member ID. Preferred names
and device labels never decide recipients. Opt-in and mute remain per device;
there is no direct-send control, delivery/read receipt or presence indicator.
The two-member diagnostic and platform checks are in
[Member and Device Identity Acceptance](IDENTITY-PAIRING-ACCEPTANCE.md).

People & devices → **Notifications on this device**:

| State | Copy |
| --- | --- |
| Browser without Push API | "This browser can't show Kin notifications." |
| iPhone/iPad in a browser tab | "Add Kin to your Home Screen to get notifications. On iPhone and iPad, only the Home Screen app can receive them." |
| Blocked in browser settings | "Notifications are blocked for Kin in this browser's settings. Allow notifications for this site there, then come back to turn them on." |
| Off | "Off." and **Turn on notifications** |
| On | "On.", **Mute for 1 hour**, **Mute for 8 hours**, **Mute until I turn them back on** and **Turn off notifications** |
| Muted | "Muted until <local date and time>." (or "until you turn them back on") and **Unmute** |
| Server without push | "Notifications aren't set up on this Kin server yet." |

The section explains once: "Notifications say only that something is new.
They never include what it is or who added it, and Kin doesn't record whether
you saw them." The browser's permission prompt appears only after **Turn on**
is pressed. The service computes a mute's end on its own clock (no time zone is
collected, and a wrong device clock can't break it); "until I turn them back
on" is stored as such and never ends by itself. Signing out of a browser turns
its notifications off (a shared computer stops getting them). Each time the
section loads it checks the service still holds this browser's current
subscription, made for the service's current keys, and quietly updates it if
not. If the browser no longer has one (site data cleared), the service forgets
it and the section shows Off: notifications are never turned back on without a
press.

The notification reads "Something new in Kin", or "Something new in <name>"
when the household published a home-screen name ([#78](HOUSEHOLD-IDENTITY-DEFAULTS.md#published-install-identity)).
Tapping it focuses an open Kin window or opens Kin; a locked Kin stays locked.

| Platform | Support |
| --- | --- |
| Chrome, Edge, Firefox (computer and Android) | Yes |
| Safari on a Mac | Yes |
| iPhone and iPad (iOS 16.4+) | Only Kin added to the Home Screen |

A server must have a VAPID subject the push services accept: its origin when
it serves Kin over `https`, or `KIN_PUSH_SUBJECT` (a `mailto:` address or an
`https` URL). Without one, for example a development server on
`http://localhost`, push is unavailable and the section says so.

## How it works

- **Subscriptions.** `PUT /api/push/subscription` stores one subscription per
  device (`push_subscriptions`, server schema 11): the endpoint, the
  browser's P-256 key and auth secret, an optional mute. `DELETE` removes it;
  `PUT /api/push/mute` takes `{ "choice": "hour" | "night" | "indefinite" | null }`. Each
  call needs a session on a trusted device of an active member, and a device
  manages only its own row.
- **Who is notified.** After a sync batch with new events commits, every
  subscribed, unmuted, still-trusted device of the household's *other*
  members. The author's own devices never are. A household pending deletion
  gets nothing.
- **Calm.** At most one push per device per two minutes. Changes inside the
  window send one more push when it ends, so the last change isn't lost. The
  push `Topic` is the fixed `kin-new`, so a push service replaces an
  undelivered notification for the same subscription; nothing in it links a
  household's devices. The notification `tag` replaces a shown one.
- **Never in the way.** Pushes are queued once the batch has committed and
  sent without blocking the response, at most four at a time, with a
  10-second timeout. 429, 5xx and network failures are retried twice (after 5 and
  30 seconds, or a `Retry-After` of up to a minute) and then dropped. 400,
  404, 410 and 413 mean the subscription will never work: it is deleted, so
  the device shows notifications as off instead of silently getting nothing.
  401 and 403 usually mean the push service refused the server's own VAPID
  signature (for example a subject it doesn't accept), so they
  are logged as `push_rejected_by_service` and every subscription is kept.
  Only the status and the push service's host are logged.
- **Sender, no dependencies** (`server/web-push.mjs`). VAPID (RFC 8292): an
  ES256 JWT for the endpoint's origin, at most 12 hours, with the deployment's
  origin (or `KIN_PUSH_SUBJECT`) as `sub`. Payload encryption (RFC 8291,
  `aes128gcm`): one record, checked against the RFC's Appendix A vector byte
  for byte ([TEST-VECTORS](TEST-VECTORS.md#push-payload-rfc-8291)). The payload
  is always `{"v":1,"kind":"new"}`.
- **Only real push services.** Endpoints must be `https` on port 443 at
  `fcm.googleapis.com`, `*.push.services.mozilla.com`, `*.push.apple.com` or
  `*.notify.windows.com`. IP literals, other ports and credentials are
  refused, so a subscription can't aim the service at another network.
- **VAPID keys** are created on first use and kept in SQLite
  (`push_vapid_keys`), not a file: the sandboxed service can't fsync files
  ([DEVELOPMENT](DEVELOPMENT.md#the-service-sandbox)), and SQLite makes the key
  durable and part of every backup. No key or endpoint is logged.
- **Lifecycle.** Revoking a device, removing a member, a Temporary member's
  expiry and leaving the household delete the affected subscriptions in the
  same transaction (the sync service's access-change hook). Household
  deletion purges them. Devices replaced during pairing or member recovery
  keep their row until the next access change, but sending re-checks trust
  every time, so nothing reaches a device that lost access.
- **The sandbox.** Node 24's permission model doesn't restrict the network,
  so pushes go out from inside it. If a later Node does, every send fails and
  the service logs `push_network_denied`.
- **Service worker.** `push` always shows the notification (browsers require
  one), reading only the manifest for the household's name and icon; it never
  opens key stores or decrypts. `notificationclick` focuses or opens Kin.
  `pushsubscriptionchange` re-subscribes with the same key and saves it. Push
  handling writes no caches.

## Not included

- Reminder notifications while Kin is closed: they would need reminder times
  on the server, a separate privacy decision.
- Per-category notifications (handoffs vs lists): they would tell the service
  what kind of event each one is.
