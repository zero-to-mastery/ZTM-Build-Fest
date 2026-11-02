// The Kin service runs under Node's permission model (#106): it may read the
// app directory and read and write only its data directory (the database,
// its WAL and lock files). It may not start child processes or workers, or
// load addons or WASI. server/start.mjs builds these flags and starts the
// service with them; the service refuses to start without them.
//
// Maintenance commands (server/admin.mjs, deploy/railway/snapshot.mjs) run as
// separate, short-lived processes outside this sandbox, because backups and
// restores write outside the data directory.
//
// The model governs Node's own APIs. SQLite's file I/O is native and is not
// checked: SQL such as ATTACH or VACUUM INTO could still write elsewhere.
// No request input reaches SQL text, so that is not reachable today.
import { dirname, join, resolve } from "node:path";
import { canonicalPath, isInsideRoot, resolveDurablePath } from "./path-safety.mjs";
import { homeDataDirectory, serverMode } from "./mode.mjs";

export const APP_ROOT = resolve(import.meta.dirname, "..");

/** The database path the service uses (createKinServer calls this too):
 * an explicit path, else KIN_DATABASE_PATH, else <data directory>/kin.sqlite
 * where the data directory is explicit, KIN_DATA_DIR, or the mode's default:
 * .kin-data in the app directory when hosted, the platform's system location
 * in home mode (ADR 0025 §10, server/mode.mjs). */
export function configuredDatabasePath({ databasePath, dataDirectory, mode } = {}, env = process.env) {
  const defaultDirectory = () => (serverMode(mode ?? env.KIN_MODE) === "home" ? homeDataDirectory(process.platform, env) : join(APP_ROOT, ".kin-data"));
  const directory = dataDirectory ?? env.KIN_DATA_DIR ?? defaultDirectory();
  return resolveDurablePath(databasePath ?? env.KIN_DATABASE_PATH ?? join(directory, "kin.sqlite"));
}

/** The directory the service may write: the database's, canonical so the
 * allowlist matches what the permission model compares (symlinks resolved). */
export function serviceDataDirectory(databasePath) {
  return canonicalPath(dirname(resolve(databasePath)));
}

/** Node flags for the service's sandbox. `appRoot` is the service's app
 * directory: this one, or a new release's while the launcher tries it before
 * updating (#722). */
export function permissionFlags(databasePath, appRoot = canonicalPath(APP_ROOT)) {
  const data = serviceDataDirectory(databasePath);
  return ["--permission", `--allow-fs-read=${appRoot}`, `--allow-fs-read=${data}`, `--allow-fs-write=${data}`];
}

/** Why the running process is not sandboxed as the service must be, or
 * null. Checked at startup so a missing path fails with a clear message. */
export function permissionProblem(databasePath, permission = process.permission) {
  if (!permission)
    return "Kin's service runs under Node's permission model. Start it with `npm start`, run.sh or run.ps1 (they use server/start.mjs), or pass --unrestricted for local development only.";
  const data = serviceDataDirectory(databasePath);
  const required = [
    ["fs.read", canonicalPath(APP_ROOT), "--allow-fs-read"],
    ["fs.read", data, "--allow-fs-read"],
    ["fs.write", data, "--allow-fs-write"],
  ];
  for (const [scope, path, flag] of required)
    if (!permission.has(scope, path))
      return `Kin's permission allowlist is missing ${JSON.stringify(path)}. Add ${flag}=${path}, or start Kin with server/start.mjs.`;
  for (const scope of ["child", "worker", "addon", "wasi"])
    if (permission.has(scope))
      return `Kin's service must not be allowed to use "${scope}". Remove that --allow flag.`;
  const app = canonicalPath(APP_ROOT);
  // The data directory may sit inside the app (.kin-data) but must not be the
  // app directory or contain it: the service would then be able to rewrite
  // its own code.
  if (isInsideRoot(app, data))
    return `Kin's data directory ${JSON.stringify(data)} contains the app. Choose a data directory of its own with KIN_DATA_DIR.`;
  // Writing anywhere but the data directory must be denied: probe the app's
  // code, the data directory's parent and the filesystem root.
  for (const canary of [join(app, "server", "server.mjs"), join(dirname(data), "kin-permission-canary"), resolve("/kin-permission-canary")])
    if (!isInsideRoot(canary, data) && permission.has("fs.write", canary))
      return `Kin's service may write only its data directory, but it may write ${JSON.stringify(canary)}. Remove the broader --allow-fs-write flag (check NODE_OPTIONS too).`;
  return null;
}
