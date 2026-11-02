// Which pairing path a code is on, and how to say so (#218, #222, #223).
//
// The service decides a code's purpose when it is created; this module only
// classifies that purpose for presentation. It grants no authority: approval,
// passkeys, fingerprints, expiry and membership gates are unchanged, and a
// purpose this module does not recognise is described as a new member, the
// path with the most visible consequence.

const ROLE = {
  adult: "Adult",
  limited: "Limited (child or teen)",
  temporary: "Temporary (babysitter, caregiver or guest)",
};

/** "own-device" | "recovery" | "new-member" */
export function pairingPath(purpose) {
  if (purpose === "device" || purpose === "replacement") return "own-device";
  if (purpose === "member-recovery") return "recovery";
  return "new-member";
}

function role(purpose) {
  return ROLE[purpose] ?? ROLE.adult;
}

/** What the person who created the code is doing. An invitation's role comes
 * from the service's `memberKind`; device codes carry `purpose` instead. */
export function inviterPathCopy(purpose, memberKind) {
  switch (pairingPath(purpose)) {
    case "own-device":
      return {
        title: "Adding your own device",
        detail: "The device that enters this code joins as you, under your member identity. It doesn't become a separate member, and you won't be notified about your own changes on it.",
        waiting: "Waiting for your other device to enter this code.",
      };
    case "recovery":
      return {
        title: "Recovering an adult's access",
        detail: "The device that enters this code restores that adult's membership. Approval revokes their old credentials and devices.",
        waiting: "Waiting for the recovering adult's device to enter this code.",
      };
    default:
      return {
        title: "Inviting another person",
        detail: `Whoever enters this code becomes a separate household member with their own identity and ${role(memberKind ?? purpose)} access. Share it only with the person you mean to invite.`,
        waiting: "Waiting for the person you invited to enter this code.",
      };
  }
}

/** What the device that entered the code is about to become. The claim
 * response does not say which role an invitation grants (it reports every
 * invitation as "adult"), so this copy never names one. */
export function joinerPathCopy(purpose) {
  switch (pairingPath(purpose)) {
    case "own-device":
      return {
        title: "Adding this device to your membership",
        detail: "This device joins as you, under your existing member identity. It doesn't create a new member.",
        next: "Next: on your other device, check that the key below matches, then approve this one.",
      };
    case "recovery":
      return {
        title: "Recovering your access",
        detail: "This device restores your membership. Your old devices will stop working.",
        next: "Next: the other household adult checks that the key below matches, then authorizes your recovery.",
      };
    default:
      return {
        title: "Joining as a new household member",
        detail: "You'll get your own member identity, with the access the inviting adult chose for you, separate from the person who invited you.",
        next: "Next: the person who invited you checks that the key below matches, then approves this device.",
      };
  }
}

/** For someone who opened a Kin code link without choosing a path first
 * (#264): what happens next, in plain words. */
export const CODE_ARRIVAL_COPY = "You opened a Kin code. Check it below, then create a passkey on this device. Someone already in the household approves it before anything is shared. Opening a code never creates a new household.";

/** A warning when the path the person chose before entering the code
 * differs from the code's real purpose, or null when they agree (or when the
 * choice is unknown, e.g. after a reload). Activation waits for the person to
 * acknowledge it, so a code never silently switches paths. */
export function intentConflict(intent, purpose) {
  const path = pairingPath(purpose);
  if (intent === "device" && path === "new-member")
    return "You chose Add my device, but this code is an invitation for a new household member. Activating it makes you a separate member, not another device of yours. If you meant to add your own device, don't activate: get an Add my device code from your other device, and let this one expire or ask its creator to revoke it.";
  if (intent === "join" && path === "own-device")
    return "You chose to join as a new member, but this code adds a device to an existing member's identity. Only continue if this is your own device and you're already in the household; otherwise ask for an invitation instead.";
  return null;
}
