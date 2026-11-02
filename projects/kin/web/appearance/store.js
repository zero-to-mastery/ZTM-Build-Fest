import { KIN_DEFAULT_SEED, normalizeHex } from "./palette.js";

export const APPEARANCE_STORE = "personal_appearance";
export const DEFAULT_APPEARANCE = Object.freeze({ version: 1, mode: "system", colorSource: "default", seed: KIN_DEFAULT_SEED, manual: null, image: null });

export function appearanceOwner(vault, actorId) {
  if (!/^[a-f0-9]{32}$/.test(vault?.vaultId ?? "") || !/^[a-f0-9]{32}$/.test(actorId ?? "")) return null;
  return `${vault.vaultId}:${actorId}`;
}

export function validateAppearance(value, owner) {
  if (value?.version === 2 && value.owner === owner) {
    if (value.mode !== undefined && !["system", "light", "dark"].includes(value.mode)) throw new Error("Kin found an invalid personal appearance record.");
    const inheritsColor = value.colorSource === undefined;
    if (inheritsColor !== (value.seed === undefined) || inheritsColor !== (value.manual === undefined)) throw new Error("Kin found an incomplete personal color choice.");
    if (!inheritsColor) validateExplicitColor(value);
    if (value.image !== undefined) validateExplicitImage(value.image);
    if (value.colorSource === "background" && !value.image) throw new Error("Kin found an incomplete background color choice.");
    return structuredClone(value);
  }
  if (!value || value.version !== 1 || value.owner !== owner || !["system", "light", "dark"].includes(value.mode) ||
      !["default", "preset", "custom", "background"].includes(value.colorSource) || !normalizeHex(value.seed)) throw new Error("Kin found an invalid personal appearance record.");
  validateExplicitColor(value);
  validateExplicitImage(value.image);
  if (value.colorSource === "background" && !value.image) throw new Error("Kin found an incomplete background color choice.");
  return structuredClone(value);
}

function validateExplicitColor(value) {
  if (!["default", "preset", "custom", "background"].includes(value.colorSource) || !normalizeHex(value.seed)) throw new Error("Kin found an invalid personal color choice.");
  if (value.manual !== null && (!value.manual || !["preset", "custom"].includes(value.manual.source) || !normalizeHex(value.manual.seed) || typeof value.manual.name !== "string")) throw new Error("Kin found an invalid personal color choice.");
}

function validateExplicitImage(image) {
  if (image !== null && (!image || !normalizeHex(image.seed) || !(image.bytes instanceof Uint8Array) || image.bytes.length > 3 * 1024 * 1024 || !["image/webp", "image/jpeg"].includes(image.type))) throw new Error("Kin found an invalid personal background.");
}

export async function loadAppearance(store, vault) {
  const owner = appearanceOwner(vault, store?.actorId);
  if (!owner) return { ...DEFAULT_APPEARANCE, owner: null };
  const transaction = store.database.transaction(APPEARANCE_STORE, "readonly");
  const row = await requestResult(transaction.objectStore(APPEARANCE_STORE).get(owner));
  return row ? validateAppearance(row, owner) : { version: 2, owner, mode: undefined, colorSource: undefined, seed: undefined, manual: undefined, image: undefined };
}

export async function saveAppearance(store, vault, value) {
  const owner = appearanceOwner(vault, store?.actorId);
  if (!owner) throw new Error("Kin couldn't establish who owns these appearance settings.");
  const record = validateAppearance({ ...value, owner }, owner);
  const transaction = store.database.transaction(APPEARANCE_STORE, "readwrite");
  transaction.objectStore(APPEARANCE_STORE).put(record);
  await transactionDone(transaction);
  return record;
}

function requestResult(request) { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
function transactionDone(transaction) { return new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error); }); }
