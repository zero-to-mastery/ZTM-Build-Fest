// The card of a prepared invitation (#613, "Set up Kin for someone"): the
// person's name, the helper's name and an optional note, sealed on the
// admin's device so the Kin service can store it with the invitation but
// never read it.
//
// The admin's device picks a random 128-bit key, encrypts the card with
// AES-GCM (Web Crypto; nothing hand-written) and puts the key in the
// invitation link's fragment beside the code (`/pair#code=…&k=…`). Browsers
// never send a fragment to a server, and Kin never sends the key anywhere, so
// only someone holding the link (the QR code on the printed sheet) can open
// the card. Every card has its own fresh key, which only its own link
// carries, so a card moved to another invitation simply doesn't open. Typing
// the code by hand works without the key: the person then types their name,
// as for any invitation.
//
// Format 1: base64url( IV (12 bytes) ‖ AES-128-GCM ciphertext and tag ) of the
// UTF-8 JSON { v: 1, name, helper, note }, with "kin/prepared-card/v1" as
// associated data.
import { fromBase64Url, toBase64Url } from "./local-vault.js";
import { normalizeUsername } from "./account-credentials.js";

export const CARD_KEY_BYTES = 16;
export const CARD_KEY_LENGTH = 22;
export const MAX_CARD_NAME = 32;
export const MAX_CARD_NOTE = 200;
const IV_BYTES = 12;
const KEY_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** The associated data naming what the ciphertext is. */
const PURPOSE = new TextEncoder().encode("kin/prepared-card/v1");

function clean(value, limit) {
  const text = String(value ?? "").trim();
  return [...text].length > limit ? [...text].slice(0, limit).join("") : text;
}

/** A card's fields, trimmed and bounded. */
export function cardFields({ name, helper, note = "" }) {
  return { name: clean(name, MAX_CARD_NAME), helper: clean(helper, MAX_CARD_NAME), note: clean(note, MAX_CARD_NOTE) };
}

/** Whether `key` looks like a card key from a link. */
export function isCardKey(key) {
  return typeof key === "string" && KEY_PATTERN.test(key);
}

/**
 * Seals `fields`. Resolves to { card, key }: the card goes to the service
 * with the invitation; the key goes only in the link.
 */
export async function sealCard(fields, cryptoApi = globalThis.crypto) {
  const raw = cryptoApi.getRandomValues(new Uint8Array(CARD_KEY_BYTES));
  const iv = cryptoApi.getRandomValues(new Uint8Array(IV_BYTES));
  try {
    const key = await cryptoApi.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
    const plain = new TextEncoder().encode(JSON.stringify({ v: 1, ...cardFields(fields) }));
    const sealed = new Uint8Array(await cryptoApi.subtle.encrypt({ name: "AES-GCM", iv, additionalData: PURPOSE }, key, plain));
    const card = new Uint8Array(IV_BYTES + sealed.length);
    card.set(iv);
    card.set(sealed, IV_BYTES);
    return { card: toBase64Url(card), key: toBase64Url(raw) };
  } finally {
    raw.fill(0);
  }
}

/** Opens a card with the link's key; null when it can't be opened (a wrong
 * or missing key, another invitation's card, or a damaged one). */
export async function openCard(card, key, cryptoApi = globalThis.crypto) {
  if (typeof card !== "string" || !isCardKey(key)) return null;
  let raw = null;
  try {
    const bytes = fromBase64Url(card);
    raw = fromBase64Url(key);
    if (bytes.length <= IV_BYTES + 16 || raw.length !== CARD_KEY_BYTES) return null;
    const imported = await cryptoApi.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
    const plain = await cryptoApi.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES), additionalData: PURPOSE },
      imported, bytes.subarray(IV_BYTES));
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain));
    if (value?.v !== 1 || typeof value.name !== "string" || typeof value.helper !== "string") return null;
    const fields = cardFields({ name: value.name, helper: value.helper, note: typeof value.note === "string" ? value.note : "" });
    return fields.name ? fields : null;
  } catch {
    return null;
  } finally {
    raw?.fill(0);
  }
}

/**
 * A username to offer someone whose family set Kin up for them: the letters
 * of their name, then four digits, e.g. "rose.4821". They can change it.
 * `digits` is four random digits (a string), passed in for tests.
 */
export function suggestUsername(name, digits) {
  const letters = String(name ?? "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20);
  return normalizeUsername(`${letters.length >= 2 ? letters : "kin"}.${digits}`) ?? `kin.${digits}`;
}

/** Four random digits for suggestUsername. */
export function randomDigits(cryptoApi = globalThis.crypto) {
  const [value] = cryptoApi.getRandomValues(new Uint32Array(1));
  return String(value % 10_000).padStart(4, "0");
}
