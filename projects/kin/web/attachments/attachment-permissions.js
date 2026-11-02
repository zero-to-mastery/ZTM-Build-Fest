// Who may remove an attachment in the app. Owner decision (v1.0): Children /
// Limited members and babysitters / guests (Temporary members) may add and
// open attachments but not remove them. A device with no server membership
// (a local-only household) is its own Adult. The relay enforces the same
// rule for the encrypted bytes (only the uploader or an Adult may delete).
export const ATTACHMENT_REMOVE_FORBIDDEN = "Only Adults can remove attachments.";

export function canRemoveAttachments(memberKind) {
  return memberKind !== "limited" && memberKind !== "temporary";
}
