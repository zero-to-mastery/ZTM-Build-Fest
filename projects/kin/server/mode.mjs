// Server modes (ADR 0025 §9, #713): KIN_MODE is `hosted` (the default, the
// service as kin.journeytocode.io runs it) or `home` (a household's own home
// server). Home mode changes only what §9 assigns to the switch:
//
// - New households are limited to the owner's: KIN_MAX_HOUSEHOLDS defaults
//   to 1, so creation closes once the household exists. An explicit
//   KIN_MAX_HOUSEHOLDS or KIN_ALLOW_NEW_HOUSEHOLDS still applies (the control
//   panel, #718, will offer raising the limit). Invitations into existing
//   households are unaffected: the limit only gates creating one.
// - The hosted-only Google Play settings, KIN_ANDROID_PACKAGE and
//   KIN_ANDROID_CERT_SHA256, are refused at startup: the Play app is bound to
//   kin.journeytocode.io (ADR 0020).
// - The data directory defaults to the platform's system location (§10)
//   instead of .kin-data inside the app. KIN_DATA_DIR still overrides it.
//
// Everything else is the same in both modes. KIN_FEEDBACK_GITHUB_* stays
// available in home mode and, as in hosted mode, is off unless configured.
// With a name in the home settings, home mode also dials the connection
// relay and ends TLS in the service (server/home/, #733); server.mjs starts
// that after the loopback listener is up.
import { win32 } from "node:path";

export const SERVER_MODES = Object.freeze(["hosted", "home"]);
/** The exit code with which the service asks its launcher to start it
 * again at once (home setup's last step, #719): EX_TEMPFAIL. */
export const RESTART_EXIT_CODE = 75;
export const HOME_MAX_HOUSEHOLDS = 1;
const HOSTED_ONLY_SETTINGS = Object.freeze(["KIN_ANDROID_PACKAGE", "KIN_ANDROID_CERT_SHA256"]);

export class ServerModeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ServerModeError";
    this.code = code;
  }
}

const isSet = (value) => value !== undefined && value !== null && String(value).trim() !== "";

/** The configured mode: an explicit value, else KIN_MODE, else "hosted".
 * Throws code `server_mode_invalid` for anything else. */
export function serverMode(value = process.env.KIN_MODE) {
  if (!isSet(value)) return "hosted";
  const mode = String(value).trim().toLowerCase();
  if (!SERVER_MODES.includes(mode))
    throw new ServerModeError(`KIN_MODE must be "hosted" or "home"; "${value}" is neither.`, "server_mode_invalid");
  return mode;
}

/** The data directory a home server uses when KIN_DATA_DIR isn't set
 * (ADR 0025 §10). The container image sets KIN_DATA_DIR=/data itself. */
export function homeDataDirectory(platform = process.platform, env = process.env) {
  if (platform === "win32") return win32.join(env.ProgramData || env.PROGRAMDATA || "C:\\ProgramData", "Kin");
  if (platform === "darwin") return "/Library/Application Support/Kin";
  return "/var/lib/kin";
}

/**
 * Applies the mode to the service's settings. `settings` holds the raw
 * values (from options or the environment) by environment-variable name.
 * Returns { mode, maxHouseholds } with the mode's default filled in; throws
 * code `home_mode_setting_refused` for a setting home mode doesn't allow.
 */
export function applyServerMode(mode, settings = {}) {
  if (mode === "home") {
    const refused = HOSTED_ONLY_SETTINGS.filter((name) => isSet(settings[name]));
    if (refused.length)
      throw new ServerModeError(
        `${refused.join(" and ")} ${refused.length > 1 ? "are" : "is"} for the hosted service's Google Play app and can't be used in home mode (KIN_MODE=home). Remove ${refused.length > 1 ? "them" : "it"}.`,
        "home_mode_setting_refused",
      );
  }
  const maxHouseholds = mode === "home" && !isSet(settings.KIN_MAX_HOUSEHOLDS) ? HOME_MAX_HOUSEHOLDS : settings.KIN_MAX_HOUSEHOLDS;
  return Object.freeze({ mode, maxHouseholds });
}
