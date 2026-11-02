// How Kin names household members (Kin keeps no member names): "You", or the
// member's kind and number, as Household access lists them. Shared by that
// list (membership.js) and chat authors (web/chat/chat-room.js), so one
// person has one label everywhere.
//
// `members` is the service's household list in its order
// (`/api/household`: { id, kind, active }). Adults and Limited members are
// numbered among the active ones of their kind; Temporary members among all
// of theirs (an ended one stays listed). The current member keeps their
// place in the numbering but is labelled "You".

export const MEMBER_KIND_LABELS = Object.freeze({ adult: "Adult", limited: "Limited member", temporary: "Temporary member" });

/** Map of member ID to label; members not listed (an Adult whose access
 * ended) are absent, and callers name them as they see fit. */
export function memberLabels(members, currentMemberId) {
  const labels = new Map();
  for (const kind of ["adult", "limited", "temporary"]) {
    const section = members.filter((member) => member.kind === kind && (kind === "temporary" || member.active));
    section.forEach((member, index) => {
      labels.set(member.id, member.id === currentMemberId ? "You" : `${MEMBER_KIND_LABELS[kind]} ${index + 1}`);
    });
  }
  return labels;
}

/** The longest preferred member name, in characters (Rust: MAX_MEMBER_NAME_CHARS). */
export const MAX_MEMBER_NAME_CHARS = 32;

/** A device's friendly label (#225). An explicit nickname always wins.
 * Otherwise the owner's preferred name goes beside the automatic name
 * ("Mikey · Chrome on iPhone"), with no possessive so the pattern stays
 * translatable; otherwise the automatic name alone, or null when neither is
 * known (callers keep their own fallback). The label is derived at display
 * time and never stored, so renaming a member updates it and can never
 * overwrite a nickname. It is presentation only, never proof of ownership. */
export function friendlyDeviceLabel({ nickname = null, automatic = null, preferredName = null } = {}) {
  if (nickname) return nickname;
  const name = typeof preferredName === "string" ? preferredName.trim() : "";
  if (automatic && name) return `${name} · ${automatic}`;
  return automatic || null;
}

/** A preferred name that would pass for the signed-in person's own label
 * ("You", "you", "Mikey (You)"). Another member's name like that is not
 * shown, so nobody can pose as "You" beside trust controls; a member can't
 * save one as their own either. Presentation only: names grant nothing. */
export function misleadingMemberName(name) {
  return typeof name === "string" && /^\s*you\s*$|\(\s*you\s*\)/i.test(name);
}
