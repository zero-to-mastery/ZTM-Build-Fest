// Recovery key labels (issue #160).
//
// Each device has its own recovery key, and an export opens only with the key
// its device had when it was made. A label such as "K-7F3A" lets a person tell
// which saved key goes with which export. It is the first 4 hex characters of
// SHA-256 over the recovery wrapper's random ID and the vault's root version.
// Both are already stored in plaintext in the security manifest and in every
// export's authenticated header, and neither is derived from the key, so the
// label reveals nothing about the key. Older exports get a label too: it is
// computed from their header, so the archive format is unchanged.
//
// Four hex characters is a label for a person to match, not an identifier:
// two keys can share one by chance (1 in 65,536).
const encoder = new TextEncoder();

/** "K-XXXX" for one recovery wrapper of a vault at `rootVersion`. */
export async function recoveryKeyLabel(wrapperId, rootVersion) {
  if (typeof wrapperId !== "string" || !/^[a-f0-9]{32}$/.test(wrapperId) || !Number.isSafeInteger(rootVersion) || rootVersion < 1)
    throw new TypeError("A recovery key label needs a wrapper ID and root version.");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`kin/recovery-key-label/v1\0${wrapperId}\0${rootVersion}`)));
  return `K-${((digest[0] << 8) | digest[1]).toString(16).padStart(4, "0").toUpperCase()}`;
}

/** Labels of the recovery keys that open a vault with `manifest`, in order.
 * An export's wrapper for the account backup code (#572) is a recovery-type
 * wrapper too, but no device key: it gets no label. */
export async function manifestRecoveryLabels(manifest) {
  const labels = [];
  for (const wrapper of manifest?.wrappers ?? [])
    if (wrapper?.type === "recovery" && !wrapper.backupCode) labels.push(await recoveryKeyLabel(wrapper.id, manifest.rootVersion));
  return labels;
}

/** "K-7F3A" or "K-7F3A or K-11B0". */
export function joinLabels(labels) {
  return labels.join(" or ");
}

/** The export's file name: kin-<YYYY-MM-DD>-<label>.kin (the date in UTC, like exportedAt). */
export function exportFileName(exportedAt, label) {
  const date = new Date(exportedAt);
  if (Number.isNaN(date.getTime())) throw new TypeError("An export file name needs the export time.");
  return `kin-${date.toISOString().slice(0, 10)}${label ? `-${label}` : ""}.kin`;
}

/** The one storage rule used wherever exports and recovery keys are mentioned. */
export const EXPORT_STORAGE_RULE =
  "Store the export and its backup key in different places, and write down which key label goes with which export.";
