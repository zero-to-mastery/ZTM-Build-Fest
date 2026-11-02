// Home settings (ADR 0025 §9–§10, #733): which connection relay the home
// server dials, the relay's zone, the server's one name, and the ACME
// directory and terms agreement for its certificate. They live in the data
// directory, in `home/settings.json` (which the control panel, #718, will
// write with mode 0600), and each can be overridden by an environment
// variable for a technical household or a container:
//
//   field            variable                     default
//   relay            KIN_HOME_RELAY               relay.kin.journeytocode.io (port 443; "host:port" for another)
//   zone             KIN_HOME_ZONE                home.kin.journeytocode.io
//   name             KIN_HOME_NAME                none: without it the tunnel doesn't start
//   acmeDirectory    KIN_HOME_ACME_DIRECTORY      Let's Encrypt production
//   acmeTermsAgreed  KIN_HOME_ACME_TERMS_AGREED   false ("true" agrees)
//
// Two fields have no variable of their own: `maxHouseholds` (1 to 10, or
// absent for home mode's default of 1), the new-household limit the control
// panel raises (ADR 0025 §9, #720), which KIN_MAX_HOUSEHOLDS, when set, wins
// over; `backupHour` (0 to 23, or absent for 3), the local hour of the
// daily backup (§10, #721); `autoUpdate` (true or absent, or false), whether
// patch and minor releases install themselves at night (§10, #722; the
// launcher reads it from the file); and `backupCopyFolder` (a full path, or
// absent for none), the second folder the launcher copies each backup to
// (§10, #763). That one is read leniently: a path that doesn't suit this
// computer, as after a restore on another kind of computer, turns the copy
// off instead of stopping Kin. isBackupCopyFolder is the strict check.
//
// `writeHomeSettings` is the only writer: the setup page and the control
// panel (#718). It merges a change into what the file holds, checks the
// result, and replaces the file atomically with mode 0600 in the 0700
// `home/` directory. Readers ignore fields they don't know, so a later
// field never breaks an older Kin.
//
// The file's format is `{ "format": 1, ...fields }`. A name directly under
// the zone (one more label) is a free name, claimed from the relay; any
// other name is the household's own domain (ADR 0025 §3).
//
// This module imports nothing from the relay, so hosted Kin can load
// server.mjs without the tunnel's code. (It does import the ACME key store,
// for its private-file writer and the `home/` directory it owns.)
import { readFile } from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import { CertificateStore, writePrivateFile } from "../acme/keys.mjs";

export const DEFAULT_RELAY = "relay.kin.journeytocode.io";
export const DEFAULT_ZONE = "home.kin.journeytocode.io";
export const LETS_ENCRYPT_DIRECTORY = "https://acme-v02.api.letsencrypt.org/directory";
export const SETTINGS_FORMAT = 1;
/** The most households the control panel lets a home server allow (§9: "a
 * small number", for example grandparents' own household). */
export const MAX_HOUSEHOLDS_LIMIT = 10;
const FIELDS = Object.freeze({
  relay: "KIN_HOME_RELAY",
  zone: "KIN_HOME_ZONE",
  name: "KIN_HOME_NAME",
  acmeDirectory: "KIN_HOME_ACME_DIRECTORY",
  acmeTermsAgreed: "KIN_HOME_ACME_TERMS_AGREED",
});

export class HomeSettingsError extends Error {
  constructor(message) {
    super(message);
    this.name = "HomeSettingsError";
    this.code = "home_settings_invalid";
  }
}

const fail = (message) => { throw new HomeSettingsError(message); };
const isSet = (value) => value !== undefined && value !== null && String(value).trim() !== "";

/** A lowercase LDH host name of 1 to 253 bytes with no trailing dot (the
 * same rule as KTUN's names, relay/ktun.mjs). */
export function isHostName(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 253) return false;
  return value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

export const homeDirectory = (dataDirectory) => join(dataDirectory, "home");
export const homeSettingsPath = (dataDirectory) => join(homeDirectory(dataDirectory), "settings.json");

/** True when `name` is a free name: exactly one label under `zone`. */
export function isFreeName(name, zone) {
  if (!name.endsWith(`.${zone}`)) return false;
  return !name.slice(0, -zone.length - 1).includes(".");
}

function parseRelay(value) {
  const text = String(value).trim().toLowerCase();
  const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(text);
  if (!match || !isHostName(match[1])) fail(`The relay "${value}" must be a host name, optionally with ":port".`);
  const port = match[2] === undefined ? 443 : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) fail(`The relay port in "${value}" must be 1 to 65535.`);
  return { host: match[1], port };
}

function parseName(value, what) {
  const name = String(value).trim().toLowerCase();
  if (!isHostName(name)) fail(`The ${what} "${value}" must be a lowercase host name such as fern.home.kin.journeytocode.io.`);
  return name;
}

function parseDirectory(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { fail(`The ACME directory "${value}" is not a URL.`); }
  if (url.protocol !== "https:") fail("The ACME directory must be an https:// URL.");
  return url.href;
}

function parseBoolean(value, what) {
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (text === "true" || text === "1") return true;
  if (text === "false" || text === "0") return false;
  return fail(`${what} must be true or false.`);
}

function parseMaxHouseholds(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_HOUSEHOLDS_LIMIT) fail(`maxHouseholds must be a whole number from 1 to ${MAX_HOUSEHOLDS_LIMIT}.`);
  return value;
}

function parseBackupHour(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > 23) fail("backupHour must be a whole number from 0 to 23.");
  return value;
}

/** The longest second backup folder Kin keeps. */
export const MAX_BACKUP_COPY_FOLDER = 1024;

/** The stored `backupCopyFolder`, or null: a string of 1 to 1024
 * characters with no NUL. Never throws (see the top of this file). */
function parseBackupCopyFolder(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= MAX_BACKUP_COPY_FOLDER && !value.includes("\0") ? value : null;
}

/**
 * `value` as a full path to a folder on this kind of computer, tidied, or
 * null when it isn't one. On Windows that is a drive letter and a
 * backslash ("E:\" or "E:\Backups"): a bare "E:" means some folder on that
 * drive, and a network share (\\nas\share) can't be reached by the account
 * Kin runs as (LOCAL SERVICE). Elsewhere it starts with "/".
 */
export function normalizeBackupCopyFolder(value, platform = process.platform) {
  if (parseBackupCopyFolder(value) === null) return null;
  if (platform === "win32") {
    if (!/^[A-Za-z]:[\\/]/.test(value)) return null;
    return win32.resolve(value);
  }
  return posix.isAbsolute(value) ? posix.resolve(value) : null;
}

/** True when `value` is a full path to a folder on this kind of computer. */
export const isBackupCopyFolder = (value, platform = process.platform) => normalizeBackupCopyFolder(value, platform) !== null;

/**
 * The effective home settings from `file` (the parsed settings.json, or
 * null) and `env`. `configured` is true when a name is set: only then does
 * home mode start the tunnel and the certificate manager.
 */
export function resolveHomeSettings(file, env = process.env) {
  if (file !== null && (typeof file !== "object" || Array.isArray(file))) fail("home/settings.json must hold a JSON object.");
  if (file && file.format !== SETTINGS_FORMAT) fail(`home/settings.json has format ${JSON.stringify(file.format)}; this Kin reads format ${SETTINGS_FORMAT}.`);
  const raw = {};
  for (const [field, variable] of Object.entries(FIELDS)) raw[field] = isSet(env[variable]) ? env[variable] : file?.[field];
  const relay = parseRelay(isSet(raw.relay) ? raw.relay : DEFAULT_RELAY);
  const zone = parseName(isSet(raw.zone) ? raw.zone : DEFAULT_ZONE, "zone");
  const name = isSet(raw.name) ? parseName(raw.name, "name") : null;
  if (name && (name === relay.host || name === zone)) fail(`The name ${name} is the relay's own; choose a name under ${zone} or your own domain.`);
  return Object.freeze({
    relay: Object.freeze(relay),
    zone,
    name,
    freeName: name ? isFreeName(name, zone) : null,
    acmeDirectory: isSet(raw.acmeDirectory) ? parseDirectory(raw.acmeDirectory) : LETS_ENCRYPT_DIRECTORY,
    acmeTermsAgreed: raw.acmeTermsAgreed === undefined || raw.acmeTermsAgreed === null || raw.acmeTermsAgreed === "" ? false : parseBoolean(raw.acmeTermsAgreed, "acmeTermsAgreed"),
    maxHouseholds: parseMaxHouseholds(file?.maxHouseholds),
    backupHour: parseBackupHour(file?.backupHour),
    autoUpdate: file?.autoUpdate === undefined || file?.autoUpdate === null ? true : parseBoolean(file.autoUpdate, "autoUpdate"),
    backupCopyFolder: parseBackupCopyFolder(file?.backupCopyFolder),
    configured: name !== null,
  });
}

/** Reads `<dataDirectory>/home/settings.json` (absent is fine) and applies
 * the environment. Throws HomeSettingsError for a bad file or value. */
export async function loadHomeSettings(dataDirectory, env = process.env) {
  return resolveHomeSettings(await readSettingsFile(dataDirectory), env);
}

async function readSettingsFile(dataDirectory) {
  try {
    return JSON.parse(await readFile(homeSettingsPath(dataDirectory), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) fail("home/settings.json is not valid JSON.");
    throw error;
  }
}

/**
 * Merges `changes` (fields of the file, as the file holds them) into
 * `home/settings.json` and writes it with mode 0600, atomically. A field set
 * to null is removed. The merged file is checked without the environment
 * before anything is written, so a bad change leaves the file as it was.
 * Resolves with the effective settings (the environment applied).
 */
export async function writeHomeSettings(dataDirectory, changes, env = process.env) {
  const current = await readSettingsFile(dataDirectory);
  if (current !== null && (typeof current !== "object" || Array.isArray(current))) fail("home/settings.json must hold a JSON object.");
  const next = { ...(current ?? {}), format: SETTINGS_FORMAT };
  for (const [field, value] of Object.entries(changes)) {
    if (field === "format") continue;
    if (value === null || value === undefined) delete next[field];
    else next[field] = value;
  }
  resolveHomeSettings(next, {});
  const store = new CertificateStore(dataDirectory);
  await store.ensureDirectory();
  await writePrivateFile(homeSettingsPath(dataDirectory), `${JSON.stringify(next, null, 2)}\n`);
  return resolveHomeSettings(next, env);
}

/** The origin a configured home server serves: https://<name>. An explicit
 * KIN_ORIGIN must be that same origin (one origin per home server, §3). */
export function homeOrigin(settings, explicitOrigin) {
  const origin = `https://${settings.name}`;
  if (isSet(explicitOrigin) && String(explicitOrigin).replace(/\/$/, "") !== origin)
    fail(`KIN_ORIGIN is ${explicitOrigin}, but this home server's name is ${settings.name}. Remove KIN_ORIGIN or set it to ${origin}.`);
  return origin;
}
