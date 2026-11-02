import { DEFAULT_APPEARANCE, validateAppearance } from "./store.js";
import { MAX_INSTALL_ICON_BYTES, pngSize } from "./install-icons.js";

export const DEFAULT_HOUSEHOLD_NAME = "Our Home";
export const DEFAULT_HOUSEHOLD_BRAND = Object.freeze({ version: 1, iconSource: "letter", icon: null });
export const MAX_HOUSEHOLD_NAME_CODE_POINTS = 80;
export const MAX_HOUSEHOLD_NAME_BYTES = 240;

export function normalizeHouseholdName(input) {
  if (typeof input !== "string") throw new Error("Enter a household name.");
  const value = input.trim().normalize("NFC");
  if (!value) throw new Error("Enter a household name.");
  if ([...value].length > MAX_HOUSEHOLD_NAME_CODE_POINTS || new TextEncoder().encode(value).length > MAX_HOUSEHOLD_NAME_BYTES) throw new Error("Use 80 characters or fewer for the household name.");
  if (/\p{Cc}|\p{Cf}|\p{Cs}/u.test(value)) throw new Error("The household name contains unsupported formatting characters.");
  return value;
}

export function validateHouseholdSettings(value) {
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error("Kin found invalid household settings.");
  const name = normalizeHouseholdName(value.name);
  const appearance = validateAppearance({ ...value.appearance, owner: "household" }, "household");
  const brand = validateHouseholdBrand(value.brand);
  return { version: 1, revision: value.revision, name, appearance, brand };
}

export function validateHouseholdBrand(value = DEFAULT_HOUSEHOLD_BRAND) {
  if (!value || value.version !== 1 || !["letter", "upload"].includes(value.iconSource))
    throw new Error("Kin found an invalid household icon.");
  if (value.iconSource === "letter") return { ...DEFAULT_HOUSEHOLD_BRAND };
  const icon = value.icon;
  if (!icon || icon.type !== "image/png" || !(icon.bytes instanceof Uint8Array) ||
      icon.bytes.length < 24 || icon.bytes.length > MAX_INSTALL_ICON_BYTES)
    throw new Error("Kin found an invalid household icon.");
  const size = pngSize(icon.bytes);
  if (size?.width !== 512 || size.height !== 512)
    throw new Error("Kin found an invalid household icon.");
  return { version: 1, iconSource: "upload", icon: { type: "image/png", width: 512, height: 512, bytes: icon.bytes.slice() } };
}

// Undefined means inherit. Null for image means an explicit no-background override.
export function resolveAppearance(personal, household) {
  const shared = household?.appearance ?? DEFAULT_APPEARANCE;
  return {
    version: 1,
    owner: personal?.owner ?? null,
    mode: personal?.mode === undefined ? shared.mode : personal.mode,
    colorSource: personal?.colorSource === undefined ? shared.colorSource : personal.colorSource,
    seed: personal?.colorSource === undefined ? shared.seed : personal.seed,
    manual: personal?.colorSource === undefined ? shared.manual : personal.manual,
    image: personal?.image === undefined ? shared.image : personal.image,
  };
}

export function useHouseholdAppearance(owner = null) {
  return { version: 2, owner, mode: undefined, colorSource: undefined, seed: undefined, manual: undefined, image: undefined };
}

// Preserve per-property inheritance when the editor submits its concrete
// preview. Only groups that differ from the preview it started with become
// personal overrides, unless an explicit reset pins every Kin default.
export function personalAppearanceFromDraft(current, draft, baseline, { forceExplicit = false } = {}) {
  const next = current.version === 2
    ? structuredClone(current)
    : { ...structuredClone(current), version: 2 };
  if (forceExplicit || draft.mode !== baseline.mode) next.mode = draft.mode;
  if (forceExplicit || !sameColor(draft, baseline)) {
    next.colorSource = draft.colorSource;
    next.seed = draft.seed;
    next.manual = structuredClone(draft.manual);
  }
  if (forceExplicit || !sameImage(draft.image, baseline.image)) next.image = structuredClone(draft.image);
  return next;
}

function sameColor(left, right) {
  return left.colorSource === right.colorSource && left.seed === right.seed &&
    left.manual?.source === right.manual?.source && left.manual?.name === right.manual?.name &&
    left.manual?.seed === right.manual?.seed;
}

function sameImage(left, right) {
  if (left === right) return true;
  if (!left || !right || left.type !== right.type || left.seed !== right.seed ||
      left.width !== right.width || left.height !== right.height || left.bytes.length !== right.bytes.length) return false;
  return left.bytes.every((byte, index) => byte === right.bytes[index]);
}

export async function encryptHouseholdSettings(value, { householdId, keyEpoch, householdKey }) {
  const checked = validateHouseholdSettings(value);
  const serializable = { ...checked, appearance: { ...checked.appearance, owner: undefined,
    image: checked.appearance.image ? { ...checked.appearance.image, bytes: bytesToBase64(checked.appearance.image.bytes) } : null },
    brand: { ...checked.brand, icon: checked.brand.icon ? { ...checked.brand.icon, bytes: bytesToBase64(checked.brand.icon.bytes) } : null } };
  const plaintext = new TextEncoder().encode(JSON.stringify(serializable));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(`kin-household-settings-v1:${householdId}:${keyEpoch}:${checked.revision + 1}`);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, householdKey, plaintext));
  const ciphertext = new Uint8Array(nonce.length + encrypted.length); ciphertext.set(nonce); ciphertext.set(encrypted, nonce.length);
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", ciphertext))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { ciphertext, digest };
}

export async function decryptHouseholdSettings(record, { householdId, householdKey }) {
  if (!record || !Number.isSafeInteger(record.revision) || record.revision < 1 || !Number.isSafeInteger(record.keyEpoch)) throw new Error("Kin found invalid shared settings metadata.");
  const bytes = base64ToBytes(record.ciphertext);
  if (bytes.length < 29) throw new Error("Kin found incomplete shared settings.");
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (digest !== record.digest) throw new Error("Kin could not verify the shared settings.");
  const aad = new TextEncoder().encode(`kin-household-settings-v1:${householdId}:${record.keyEpoch}:${record.revision}`);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: aad }, householdKey, bytes.slice(12));
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
  if (parsed?.appearance?.image) parsed.appearance.image.bytes = base64ToBytes(parsed.appearance.image.bytes);
  if (parsed?.brand?.icon) parsed.brand.icon.bytes = base64ToBytes(parsed.brand.icon.bytes);
  return validateHouseholdSettings({ ...parsed, revision: record.revision });
}

function bytesToBase64(bytes) { let binary = ""; for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)); return btoa(binary); }
function base64ToBytes(value) { if (typeof value !== "string") throw new Error("Kin found invalid shared settings bytes."); const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(binary, (character) => character.charCodeAt(0)); }
