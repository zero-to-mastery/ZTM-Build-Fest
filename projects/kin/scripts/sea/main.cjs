// The entry point of Kin's single executable (ADR 0025 §10, #714). Node runs
// this script from the executable's SEA blob; scripts/build-sea.mjs builds
// the blob with the server, the web app and the WASM engine as assets.
//
// Node only runs a CommonJS main script from a blob, and from there it can't
// load the server's ES modules out of the blob. So the launcher first writes
// the app's files to a cache directory (once per build, checked against the
// SHA-256 of every file on each start) and loads them from disk. The cache
// directory is then the service's read-only app directory, exactly as the
// project folder is for `node server/start.mjs`.
//
// The executable runs in two roles:
//
//   launcher (default)  unpacks the app, then runs server/launcher.mjs: the
//                       service, --install-service, --health, admin, …
//   service             KIN_SEA_ROLE=service, started by the launcher with
//                       Node's permission flags in NODE_OPTIONS (a single
//                       executable takes no Node flags on its command line);
//                       loads server/server.mjs and serves.
//
// Without KIN_MODE the executable runs in home mode: it is the home server.
// The app cache is KIN_APP_CACHE or --app-cache, else systemd's
// CACHE_DIRECTORY, else the user's cache folder (Kin/ inside it).
"use strict";

const { createHash, randomBytes } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const sea = require("node:sea");
const { pathToFileURL } = require("node:url");
const vm = require("node:vm");

const MANIFEST_ASSET = "kin/manifest.json";
const FILE_ASSET_PREFIX = "kin/files/";

function fail(message) {
  process.stderr.write(`${JSON.stringify({ event: "startup_failed", outcome: "executable", message })}\n`);
  process.exit(1);
}

// import() of a file on disk. A SEA's main script has no module loader of
// its own; this compiles a one-line function with the main context's default
// loader. Node marks that option experimental, so its one warning is dropped.
function importFile(file) {
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    if (String(warning?.message ?? warning).includes("USE_MAIN_CONTEXT_DEFAULT_LOADER")) return;
    emitWarning.call(process, warning, ...rest);
  };
  try {
    const script = new vm.Script("(specifier) => import(specifier)", {
      filename: path.join(path.dirname(file), "kin-sea-import.cjs"),
      importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    });
    return script.runInThisContext()(pathToFileURL(file).href);
  } finally {
    process.emitWarning = emitWarning;
  }
}

function readManifest() {
  const manifest = JSON.parse(sea.getAsset(MANIFEST_ASSET, "utf8"));
  if (manifest?.format !== 1 || !Array.isArray(manifest.files) || !/^[0-9a-f]{64}$/.test(manifest.bundle))
    fail("This executable's app manifest is damaged.");
  return manifest;
}

function defaultCacheRoot(env) {
  if (env.CACHE_DIRECTORY) return env.CACHE_DIRECTORY.split(":")[0];
  const home = require("node:os").homedir();
  if (process.platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Kin");
  if (process.platform === "darwin") return path.join(home, "Library", "Caches", "Kin");
  return path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), "kin");
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Every file present with the recorded size and SHA-256.
function intact(directory, manifest) {
  for (const file of manifest.files) {
    let bytes;
    try { bytes = fs.readFileSync(path.join(directory, ...file.path.split("/"))); } catch { return false; }
    if (bytes.length !== file.size || sha256(bytes) !== file.sha256) return false;
  }
  return true;
}

// Writes the app's files to <root>/app-<bundle> (via a temporary directory
// renamed into place, so a half-written copy is never used) and returns that
// directory. Older builds' copies are removed.
//
// Several copies of the executable may unpack at once (the service starting
// while `kin --health` runs, say), and on Windows a directory can't be
// renamed onto one that exists, or removed while a running service has its
// files open. So: a copy that is already intact is used as it is, whoever
// wrote it; a damaged one is removed (retrying while Windows holds it)
// before the rename; and losing the rename to another process that wrote an
// intact copy first is fine.
const RENAME_RACE = new Set(["ENOTEMPTY", "EEXIST", "EPERM", "EBUSY", "EACCES"]);

// fs.promises.rm, not rmSync: some Node 24 releases' rmSync stops at the
// first EPERM on Windows instead of retrying (#785).
const removeFolder = (folder, maxRetries) => fs.promises.rm(folder, { recursive: true, force: true, maxRetries, retryDelay: 100 });

async function unpack(root, manifest) {
  const name = `app-${manifest.bundle.slice(0, 16)}`;
  const target = path.join(root, name);
  if (intact(target, manifest)) return target;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const staging = path.join(root, `.${name}-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    for (const file of manifest.files) {
      const bytes = Buffer.from(sea.getRawAsset(FILE_ASSET_PREFIX + file.path));
      if (bytes.length !== file.size || sha256(bytes) !== file.sha256) fail(`This executable's copy of ${file.path} is damaged.`);
      const destination = path.join(staging, ...file.path.split("/"));
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
      fs.writeFileSync(destination, bytes, { mode: 0o644 });
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.renameSync(staging, target);
        break;
      } catch (error) {
        if (!RENAME_RACE.has(error.code) || attempt >= 5) throw error;
        if (intact(target, manifest)) {
          await removeFolder(staging, 10);
          break;
        }
        await removeFolder(target, 10);
      }
    }
  } catch (error) {
    await removeFolder(staging, 10);
    fail(`Kin couldn't unpack its app files into ${root} (${error.code ?? error.message}). Set KIN_APP_CACHE to a folder this account can write.`);
  }
  // Other builds' copies go; another process's unpacking of this build
  // (.app-<same bundle>-…) is left alone. Removal is best effort: Windows
  // keeps a folder a running older version still uses.
  for (const entry of fs.readdirSync(root)) {
    if (entry === name || entry.startsWith(`.${name}-`) || !/^\.?app-[0-9a-f]{16}/.test(entry)) continue;
    try { await removeFolder(path.join(root, entry), 3); } catch {}
  }
  return target;
}

// A Node option for NODE_OPTIONS, quoted when it holds a space or quote.
function nodeOption(flag) {
  return /[\s"\\]/.test(flag) ? `"${flag.replace(/[\\"]/g, "\\$&")}"` : flag;
}

async function service() {
  const directory = process.env.KIN_SEA_APP_DIR;
  if (!directory || !path.isAbsolute(directory)) fail("The service was started without its app directory.");
  const entry = path.join(directory, "server", "server.mjs");
  // server.mjs serves when it is the program's main module.
  process.argv[1] = entry;
  await importFile(entry);
}

async function launcher() {
  const manifest = readManifest();
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === "--version") {
    process.stdout.write(`${manifest.version}\n`);
    return;
  }
  // --app-cache is the executable's own option (the Windows task can't set
  // environment variables); --prepare unpacks and stops (the container build).
  let cacheRoot = process.env.KIN_APP_CACHE || null;
  let prepareOnly = false;
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--app-cache" && index + 1 < argv.length) cacheRoot = argv[++index];
    else if (argv[index].startsWith("--app-cache=")) cacheRoot = argv[index].slice("--app-cache=".length);
    else if (argv[index] === "--prepare") prepareOnly = true;
    else rest.push(argv[index]);
  }
  // Set on the process itself, so the admin commands see it too.
  if (!process.env.KIN_MODE) process.env.KIN_MODE = "home";
  const env = process.env;
  // The service's permission flags name its app directory by its real path
  // (server/permissions.mjs), and the permission model compares paths as
  // written. So the service must load its files by that path too, not
  // through a symlink: macOS's temporary folders (/var/folders, /tmp) are
  // symlinks into /private.
  const appCache = path.resolve(cacheRoot || defaultCacheRoot(env));
  const appDirectory = fs.realpathSync(await unpack(appCache, manifest));
  if (prepareOnly) {
    process.stdout.write(`${appDirectory}\n`);
    return;
  }
  const { runLauncher } = await importFile(path.join(appDirectory, "server", "launcher.mjs"));
  // How to start the service from an executable and its unpacked app: this
  // one, or a new release's while the launcher tries it before updating
  // (server/home/updater.mjs, #722).
  const serviceProcessFor = ({ executable, appDirectory: directory }) => ({ flags, env: serviceEnv }) => ({
    command: executable,
    args: [],
    env: {
      ...serviceEnv,
      KIN_SEA_ROLE: "service",
      KIN_SEA_APP_DIR: directory,
      NODE_OPTIONS: [...flags.map(nodeOption), serviceEnv.NODE_OPTIONS].filter(Boolean).join(" "),
    },
  });
  const code = await runLauncher(rest, {
    version: manifest.version,
    env,
    serviceProcess: serviceProcessFor({ executable: process.execPath, appDirectory }),
    program: { kind: "sea", executable: process.execPath, appCache, appDirectory, serviceProcessFor },
  });
  process.exit(code);
}

(process.env.KIN_SEA_ROLE === "service" ? service() : launcher()).catch((error) => fail(error?.message ?? String(error)));
