# ADR 0300: Destinations are discovered from the grant and offered only when the provider confirms them

- Status: Accepted
- Date: 2026-10-29
- Parent epic: [#353](https://github.com/journey-to-code-org/open.blog/issues/353)
- Story: #355 (task #365)

## Context

A LinkedIn authorization names a member, who may also administer organizations. A Facebook authorization names a
person who manages Pages. The site announces to one of these, not to "the login", so the function has to find
the choices, decide which of them it may really post to, and never claim a capability it could not verify. Provider
approval (LinkedIn's Community Management API, Meta's App Review) varies per app and changes over time.

## Decision

- **Discovery runs inside the handshake**, right after the scopes are verified (ADR 0299), and the result is
  stored on the connection as `destinations` plus `notes`. Neither holds a token. Provider-supplied names are
  stripped of control and bidirectional-override characters, collapsed and cut to 200 characters; ids are
  validated by shape (`urn:li:person:<id>`, `urn:li:organization:<digits>`, a numeric Page id) or skipped.
- **LinkedIn**: the member comes from OpenID `userinfo` (`sub`), eligible when `w_member_social` was granted.
  Organizations are asked for only when the deployer requested the organization scopes; they are listed from
  `organizationAcls` for approved administrators, with `Linkedin-Version` and `X-Restli-Protocol-Version` headers,
  and eligible only with `w_organization_social` granted. A 401/403 is reported as `organizations-not-approved`,
  a failure as `organizations-unavailable`, scopes not granted as `organizations-not-granted`, nothing asked as
  `organizations-not-requested`, and an empty list as `no-organizations`: five different facts, never conflated.
- **Facebook**: Pages come from `/me/accounts` with their `tasks`. A Page is eligible only when
  `pages_manage_posts` was granted, the person's tasks include `CREATE_CONTENT` and a Page token came back. A Page
  whose tasks were not reported is shown as `role-unverified`, not offered, and never guessed eligible. Each
  Page's token goes only into the sealed envelope. Meta's App Review status is not readable from the API, so a
  fixed `app-review-unverified` note always says so and tells the deployer to confirm it in the Meta dashboard.
- **Nothing eligible ends the attempt.** The reasons stay on the failed row for Admin to show; no token is kept
  and the LinkedIn grant is withdrawn.
- **Choosing is a once-only, atomic step.** `select` names a destination from that connection's own list. It
  claims the connection (`authorized -> exchanging`, version checked), creates the account, stores that
  destination's credential through the credential store (ADR 0295), and completes the connection, erasing the
  handshake tokens. If anything fails after the claim, the half-made account is disconnected and the connection
  returns to `authorized`, so the author can choose again without signing in again. A destination that is
  already connected is refused as `already-connected` (the live-account unique index decides).
- **Organizations share the member's grant, Pages do not.** Each LinkedIn account gets its own copy of the
  member's tokens, so disconnecting one erases only that copy. A Facebook Page account stores only that Page's
  token.
- **Reconnect binds to the identity.** A reconnect is a handshake carrying the account id. It finishes only when
  the destination list contains that account's provider id and it is eligible; a different login is refused as
  `identity-mismatch`, the grant is withdrawn and the stored credential is untouched.
- **Disconnect erases our copy and keeps the row.** LinkedIn is also asked to revoke the grant, but only when no
  other live LinkedIn account could share it. Facebook is never revoked per Page: a Page token cannot withdraw
  the person's grant, and withdrawing it would cut off every other Page; the guide tells the author to remove the
  app in Facebook's settings. Provider failure never blocks the erase.
- **Health is computed from plain columns.** `ok`, `expiring` (within seven days of the last moment a token or
  its refresh token can work), `needs-reauth` (flagged, credential erased or missing, or past that moment) and
  `disconnected`, so Admin can ask for reauthorization without decrypting anything.

## Considered options

- **Guess eligibility from granted scopes alone.** Rejected: a Page role or an organization approval can be
  missing while the scope is granted, and posting would fail later at delivery.
- **Revoke at the provider on every disconnect.** Rejected: it would break sibling accounts that share a grant.
- **Store Page tokens on the connection row in plain columns.** Rejected: only sealed material may hold a token.

## Consequences

- `openblog_social_connections` gains a `notes` column in the same additive file.
- A later story that delivers posts reads credentials only through the credential store and treats a
  `needs-reauth` account as undeliverable.
