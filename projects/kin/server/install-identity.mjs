// The household install identity (#78): a name, short name, description and
// icons a household admin chose to publish *unencrypted*, so the app the
// household installs shows them on home screens. Everything else about the
// household stays inside encrypted household settings, which this never
// reads. Validation is hand-written (no packages): text by code points and
// graphemes, icons by their PNG header only. The server never decodes or
// renders an image; the publishing browser draws the icons.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PairingError } from "./pairing-service.mjs";
import { webRoot } from "./path-safety.mjs";

export const MAX_INSTALL_NAME_CODE_POINTS = 80;
export const MAX_INSTALL_NAME_BYTES = 240;
export const MAX_INSTALL_SHORT_NAME_GRAPHEMES = 12;
export const MAX_INSTALL_DESCRIPTION_CODE_POINTS = 200;
export const MAX_INSTALL_ICON_BYTES = 512 * 1024;

/** Each published icon: its storage column, URL file name and exact size. */
export const INSTALL_ICONS = Object.freeze([
  Object.freeze({ key: "icon192", column: "icon_192", file: "192.png", size: 192 }),
  Object.freeze({ key: "icon512", column: "icon_512", file: "512.png", size: 512 }),
  Object.freeze({ key: "maskable512", column: "icon_maskable_512", file: "maskable-512.png", size: 512 }),
  Object.freeze({ key: "apple180", column: "icon_apple_180", file: "apple-180.png", size: 180 }),
]);

const invalid = (message) => new PairingError("install_identity_invalid", message, 400);
const UNSUPPORTED = /\p{Cc}|\p{Cf}|\p{Cs}/u;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The household name, by the same rules as the encrypted household name. */
export function installName(value) {
  if (typeof value !== "string") throw invalid("Enter a household name.");
  const name = value.trim().normalize("NFC");
  if (!name) throw invalid("Enter a household name.");
  if ([...name].length > MAX_INSTALL_NAME_CODE_POINTS || Buffer.byteLength(name) > MAX_INSTALL_NAME_BYTES)
    throw invalid("Use 80 characters or fewer for the household name.");
  if (UNSUPPORTED.test(name)) throw invalid("The household name contains unsupported formatting characters.");
  return name;
}

/** The home-screen label: at most 12 user-perceived characters. */
export function installShortName(value) {
  if (typeof value !== "string") throw invalid("Enter a short name.");
  const name = value.trim().normalize("NFC");
  if (!name) throw invalid("Enter a short name.");
  if ([...graphemes.segment(name)].length > MAX_INSTALL_SHORT_NAME_GRAPHEMES || [...name].length > 48)
    throw invalid("Use 12 characters or fewer for the short name.");
  if (UNSUPPORTED.test(name.replace(/‍/g, ""))) throw invalid("The short name contains unsupported formatting characters.");
  return name;
}

/** An optional description; empty means the built-in one. */
export function installDescription(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw invalid("The description must be text.");
  const text = value.trim().normalize("NFC");
  if ([...text].length > MAX_INSTALL_DESCRIPTION_CODE_POINTS) throw invalid("Use 200 characters or fewer for the description.");
  if (UNSUPPORTED.test(text)) throw invalid("The description contains unsupported formatting characters.");
  return text;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IEND = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

/** Checks a PNG by its framing only: signature, an IHDR chunk first with
 * exactly `size` x `size`, a valid bit depth and colour type, and the IEND
 * chunk last. Returns the bytes as a Buffer. Nothing is decoded. */
export function installIcon(value, size) {
  let bytes;
  if (Buffer.isBuffer(value)) bytes = value;
  else if (typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value)) bytes = Buffer.from(value, "base64url");
  else throw invalid("Every icon must be a PNG image.");
  if (bytes.length < 8 + 25 + IEND.length || bytes.length > MAX_INSTALL_ICON_BYTES)
    throw invalid("Each icon must be a PNG of at most 512 KB.");
  const validDepth = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (
    !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("latin1", 12, 16) !== "IHDR" ||
    bytes.readUInt32BE(16) !== size ||
    bytes.readUInt32BE(20) !== size ||
    !validDepth[bytes[25]]?.includes(bytes[24]) ||
    bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1 ||
    !bytes.subarray(bytes.length - IEND.length).equals(IEND)
  )
    throw invalid(`Each icon must be a ${size} by ${size} PNG image.`);
  return bytes;
}

/** A hash of everything published, which names its icon URLs and the
 * manifest ETag: they change whenever the content does, whatever the
 * revision (which a backup restore can repeat). */
export function installContentTag(value) {
  const hash = createHash("sha256");
  for (const text of [value.name, value.shortName, value.description, value.iconSource])
    hash.update(`${Buffer.byteLength(text)}:${text};`);
  for (const { key } of INSTALL_ICONS) hash.update(`${value.icons[key].length}:`).update(value.icons[key]);
  return hash.digest("hex").slice(0, 16);
}

/** A complete publish request, validated. */
export function validateInstallIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Those home screen details are invalid.");
  if (!Number.isSafeInteger(value.expectedRev) || value.expectedRev < 0) throw invalid("Those home screen details are invalid.");
  if (!["letter", "upload"].includes(value.iconSource)) throw invalid("Choose a first-letter or uploaded icon.");
  const icons = value.icons;
  if (!icons || typeof icons !== "object") throw invalid("Every icon must be a PNG image.");
  return {
    expectedRev: value.expectedRev,
    name: installName(value.name),
    shortName: installShortName(value.shortName),
    description: installDescription(value.description),
    iconSource: value.iconSource,
    icons: Object.fromEntries(INSTALL_ICONS.map(({ key, size }) => [key, installIcon(icons[key], size)])),
  };
}

/** A published icon's URL: its file name and the content tag. */
export function installIconUrl(file, identity) {
  return `/install-icon/${file}?v=${identity.contentTag}`;
}

let builtIn = null;
/** The built-in Kin manifest (web/manifest.webmanifest) and its ETag. */
export function builtInManifest() {
  if (!builtIn) {
    const body = readFileSync(join(webRoot, "manifest.webmanifest"));
    builtIn = { body, etag: `"kin-default-${createHash("sha256").update(body).digest("hex").slice(0, 16)}"` };
  }
  return builtIn;
}

/** The manifest for a published identity. id, start_url, scope and display
 * are the built-in manifest's, so installed apps update in place. */
export function publishedManifest(householdId, identity) {
  const base = JSON.parse(builtInManifest().body.toString("utf8"));
  const icon192 = installIconUrl("192.png", identity);
  const manifest = {
    ...base,
    name: identity.name,
    short_name: identity.shortName,
    description: identity.description || base.description,
    icons: [
      { src: icon192, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: installIconUrl("512.png", identity), sizes: "512x512", type: "image/png", purpose: "any" },
      { src: installIconUrl("maskable-512.png", identity), sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    // Shortcuts keep Kin's own PNG icons (#473): each shows what the
    // shortcut does (a bag, a ticked box, a calendar), which the household's
    // icon on every one of them couldn't.
  };
  // The ETag covers the household, the published content and Kin's own
  // manifest, whose colours and shortcuts the published one carries over.
  const tag = createHash("sha256")
    .update(`kin-install:${householdId}:${identity.contentTag}:${builtInManifest().etag}`)
    .digest("hex").slice(0, 24);
  return { body: Buffer.from(JSON.stringify(manifest), "utf8"), etag: `"${tag}"` };
}

/** Whether an If-None-Match header names `etag`. */
export function etagMatches(header, etag) {
  if (typeof header !== "string") return false;
  return header.split(",").some((value) => value.trim().replace(/^W\//, "") === etag || value.trim() === "*");
}
