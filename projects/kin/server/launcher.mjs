// The Kin launcher: the one part of Kin that may start processes (#106). It
// starts the service inside Node's permission model (server/permissions.mjs)
// and, for the home server (ADR 0025 §10, #713), installs or removes Kin as
// a service, answers a health check and runs the admin commands.
//
// Two programs use it. `node server/start.mjs` runs the service as
// `node --permission … server/server.mjs`. The single executable
// (scripts/sea/main.cjs) can't pass Node flags on its command line, so it
// starts a second copy of itself with the flags in NODE_OPTIONS; how the
// service process is started is the caller's `serviceProcess`.
//
// In home mode it also watches the service's output for the control
// panel's one-time codes (ADR 0025 §10, #719): it shows each in plain words,
// and on first run, in a terminal, opens the browser at the setup page (the
// service itself may not start processes). The service asks to be started
// again, after setup writes its name, by exiting with RESTART_EXIT_CODE.
//
// On Windows the service is run by Kin's service host (tools/kin-service-host,
// #749), which starts this launcher with --stop-on-stdin-close and asks it to
// stop by closing its stdin: a Windows service has no console to send Ctrl+C
// to, and ending a process gives it no chance to close its database.
//
// In home mode it also runs the updater (server/home/updater.mjs, #722),
// which may stop the service, try a new release as the service, and keep it
// or go back, through the controller runService hands it.
//
// And it copies each backup to the second folder the person chose
// (server/home/backup-copy.mjs, #763): the service may write only its data
// directory. The service's `home_backup_created` line tells the copier to
// look at once; it also looks every minute.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, renameSync, statSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { constants } from "node:os";
import { canonicalPath } from "./path-safety.mjs";
import { configuredDatabasePath, permissionFlags } from "./permissions.mjs";
import { RESTART_EXIT_CODE } from "./mode.mjs";

export const USAGE = `Usage: kin [command] [options]

Commands (at most one):
  (none)                 run Kin
  --install-service      install Kin as a service that starts when the computer
                         starts and restarts if it fails (needs admin rights)
  --uninstall-service    remove the service; Kin's data directory is kept
  --print-service        print the service definition without installing it
  --health               exit with 0 if the running service answers /health
  --version              print Kin's version
  --help                 show this help
  admin <arguments>      run an admin command (backup, restore, …)

Options:
  --supervise            restart the service when it fails (the Windows task uses it)
  --stop-on-stdin-close  stop the service when this program's stdin closes (the
                         Windows service host uses it)
  --log-file PATH        append the service's output to PATH
  --user NAME            macOS: the account the service runs as (default: the
                         account that ran sudo)
  --platform NAME        with --print-service: linux, darwin or win32`;

const COMMANDS = Object.freeze({
  "--install-service": "install-service",
  "--uninstall-service": "uninstall-service",
  "--print-service": "print-service",
  "--health": "health",
  "--version": "version",
  "--help": "help",
  "-h": "help",
});
const PLATFORMS = Object.freeze(["linux", "darwin", "win32"]);
const LOG_ROTATE_BYTES = 10 * 1024 * 1024;
const RESTART_MIN_MS = 1_000;
const RESTART_MAX_MS = 60_000;
const RESTART_RESET_MS = 60_000;
const CODE_EVENT = '"event":"home_control_code"';
const PANEL_URL = /^http:\/\/localhost:\d{1,5}\/control\/$/;
const BACKUP_EVENT = '"event":"home_backup_created"';

/** True for the line the service prints when it made a backup
 * (server/home/backups.mjs). It only says "look now": the copier finds
 * the sets itself. */
export function describeBackupLine(line) {
  if (!line.includes(BACKUP_EVENT)) return false;
  let event;
  try { event = JSON.parse(line); } catch { return false; }
  return event?.event === "home_backup_created";
}

/** What the launcher shows for a control-panel code the service printed
 * (server/home/control-panel.mjs), or null for any other line. */
export function describeCodeLine(line) {
  if (!line.includes(CODE_EVENT)) return null;
  let event;
  try { event = JSON.parse(line); } catch { return null; }
  if (event?.event !== "home_control_code" || typeof event.code !== "string" || !PANEL_URL.test(event.url ?? "")) return null;
  const until = Number.isNaN(Date.parse(event.expiresAt)) ? "" : ` It works once, until ${new Date(event.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`;
  const text = {
    setup: `Set up Kin: open ${event.url} on this computer and enter the setup code ${event.code}.${until}`,
    access: `To open Kin's control panel, go to ${event.url} on this computer and enter the code ${event.code}.${until}`,
    confirm: `To confirm the change in Kin's control panel, enter the code ${event.code}.${until}`,
    move: `To move a household to this home server, enter the move code ${event.code} on the address it is moving from.${until}`,
  }[event.purpose];
  return text ? { purpose: event.purpose, url: event.url, text } : null;
}

/** Opens `url` (the setup page on this computer) in the default browser,
 * best effort: no browser, no desktop or a failure just leaves the printed
 * address. Returns the spawned process or null. */
export function openBrowser(url, { platform = process.platform, env = process.env, spawnImpl = spawn } = {}) {
  if (!PANEL_URL.test(url)) return null;
  const command = platform === "darwin" ? ["open", [url]]
    : platform === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
    : env.DISPLAY || env.WAYLAND_DISPLAY ? ["xdg-open", [url]] : null;
  if (!command) return null;
  try {
    const child = spawnImpl(command[0], command[1], { stdio: "ignore", detached: platform !== "win32", windowsHide: true });
    child.on?.("error", () => {});
    child.unref?.();
    return child;
  } catch {
    return null;
  }
}

export class LauncherUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "LauncherUsageError";
  }
}

/** The launcher's command line as { command, supervise, stopOnStdinClose,
 * logFile, user, platform, adminArgs }. Throws LauncherUsageError. */
export function parseLauncherArguments(argv) {
  const options = { command: "run", supervise: false, stopOnStdinClose: false, logFile: null, user: null, platform: null, adminArgs: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "admin") {
      if (options.command !== "run") throw new LauncherUsageError("Give one command at a time.");
      options.command = "admin";
      options.adminArgs = argv.slice(index + 1);
      break;
    }
    const equals = argument.startsWith("--") ? argument.indexOf("=") : -1;
    const name = equals > 0 ? argument.slice(0, equals) : argument;
    const value = () => {
      if (equals > 0) return argument.slice(equals + 1);
      index += 1;
      if (index >= argv.length || argv[index].startsWith("--")) throw new LauncherUsageError(`${name} needs a value.`);
      return argv[index];
    };
    if (COMMANDS[name] && equals < 0) {
      if (options.command !== "run") throw new LauncherUsageError("Give one command at a time.");
      options.command = COMMANDS[name];
    } else if (name === "--supervise" && equals < 0) options.supervise = true;
    else if (name === "--stop-on-stdin-close" && equals < 0) options.stopOnStdinClose = true;
    else if (name === "--log-file") options.logFile = value();
    else if (name === "--user") options.user = value();
    else if (name === "--platform") options.platform = value();
    else throw new LauncherUsageError(`Unknown argument "${argument}".`);
  }
  if ((options.supervise || options.stopOnStdinClose || options.logFile) && options.command !== "run")
    throw new LauncherUsageError("--supervise, --stop-on-stdin-close and --log-file are for running Kin.");
  if (options.logFile === "") throw new LauncherUsageError("--log-file needs a path.");
  if (options.user !== null && !["install-service", "print-service"].includes(options.command))
    throw new LauncherUsageError("--user is for --install-service and --print-service.");
  if (options.user !== null && !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(options.user))
    throw new LauncherUsageError(`"${options.user}" isn't an account name.`);
  if (options.platform !== null && options.command !== "print-service")
    throw new LauncherUsageError("--platform is for --print-service.");
  if (options.platform !== null && !PLATFORMS.includes(options.platform))
    throw new LauncherUsageError(`--platform must be one of ${PLATFORMS.join(", ")}.`);
  return options;
}

/** The URL the health check asks: the service's own listener. */
export function healthUrl(env = process.env) {
  const host = env.KIN_HOST || "127.0.0.1";
  const port = Number(env.KIN_PORT ?? 8000);
  const hostPart = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${hostPart}:${port}/health`;
}

/** 0 when the running service answers /health within five seconds, else 1. */
export async function checkHealth(env = process.env, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(healthUrl(env), { signal: AbortSignal.timeout(5_000) });
    await response.body?.cancel();
    return response.ok ? 0 : 1;
  } catch {
    return 1;
  }
}

/** Opens `path` for appending (owner-only), first moving a file over 10 MiB
 * to `path.1` so a long-running service's log can't fill the disk. */
function openLog(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0;
  if (size > LOG_ROTATE_BYTES) renameSync(path, `${path}.1`);
  return openSync(path, "a", 0o600);
}

/**
 * Runs the service until it stops and resolves with the exit code the
 * launcher should use. `serviceProcess({ flags, env })` returns the
 * { command, args, env } that starts the service with the sandbox flags.
 * With `supervise`, a service that fails is started again after a delay
 * (1 second, doubling to 1 minute, reset after a minute up). With
 * `stopOnStdinClose`, the end of `stdin` stops the service as SIGTERM does.
 */
export function runService({ serviceProcess, env = process.env, supervise = false, stopOnStdinClose = false, logFile = null, spawnImpl = spawn, signals = process, stdin = process.stdin, platform = process.platform, stdout = process.stdout, stderr = process.stderr, interactive = Boolean(process.stdout.isTTY), open = openBrowser, updater = null, backupCopy = null }) {
  let log = null;
  const write = (stream, line) => {
    if (log !== null) writeSync(log, `${line}\n`);
    else stream.write(`${line}\n`);
  };
  // Home mode: the control panel's codes are shown, and the setup page
  // opened once, in a terminal only (a service manager has no screen).
  const watchCodes = String(env.KIN_MODE ?? "").trim().toLowerCase() === "home";
  let browserOpened = false;
  let pending = "";
  // The copier (#763), once its factory has made it.
  let copier = null;
  const watch = (chunk) => {
    pending += chunk.toString("utf8");
    if (pending.length > 65_536) pending = pending.slice(-65_536);
    let end;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (describeBackupLine(line)) { copier?.backupMade(); continue; }
      const code = describeCodeLine(line);
      if (!code) continue;
      if (interactive || log === null) stderr.write(`\n${code.text}\n\n`);
      if (code.purpose === "setup" && interactive && !supervise && !stopOnStdinClose && !browserOpened && env.KIN_OPEN_BROWSER !== "0") {
        browserOpened = true;
        open(code.url, { platform, env });
      }
    }
  };
  let databasePath;
  let flags;
  try {
    if (logFile) log = openLog(logFile);
    const configured = configuredDatabasePath({}, env);
    // The sandbox can only write inside the data directory, so it is made
    // here, owner-only. The permission model compares paths as written, so
    // the service is given the canonical path (symlinks resolved).
    mkdirSync(dirname(configured), { recursive: true, mode: 0o700 });
    databasePath = join(canonicalPath(dirname(configured)), basename(configured));
    flags = permissionFlags(databasePath);
  } catch (error) {
    write(process.stderr, JSON.stringify({ event: "startup_failed", outcome: "configuration_or_storage", message: error.message }));
    if (log !== null) closeSync(log);
    return Promise.resolve(1);
  }
  // The service learns of a stop from its stdin closing when Windows has no
  // signal to give it: under --supervise (the scheduled task ends the
  // launcher outright) and --stop-on-stdin-close (the service host).
  const stopByPipe = supervise || stopOnStdinClose;
  const serviceEnv = { ...env, KIN_DATABASE_PATH: databasePath, ...(stopByPipe ? { KIN_STOP_WITH_LAUNCHER: "1" } : {}) };
  let spec = serviceProcess({ flags, env: serviceEnv });

  return new Promise((resolveExit) => {
    let child = null;
    let stopping = false;
    let delay = RESTART_MIN_MS;
    let restartTimer = null;
    // The updater's hold on the service (#722): while `paused`, an exit is
    // expected and nothing restarts; while `onTrialExit` is set, the running
    // service is a release on trial and its exit goes to the updater.
    let paused = false;
    let onTrialExit = null;
    let update = null;
    const exited = [];
    const running = () => child !== null && child.exitCode === null && child.signalCode === null;
    // A clean stop, as a service manager's would be: SIGTERM, or on Windows
    // the closed stdin pipe; after 45 seconds, an end.
    const stopChild = () => {
      if (platform === "win32") child.stdin?.end();
      else child.kill("SIGTERM");
      const force = setTimeout(() => { if (running()) child.kill(); }, 45_000);
      force.unref?.();
    };
    const controller = {
      canStop: platform !== "win32" || stopByPipe,
      serviceEnv,
      get spec() { return spec; },
      flagsFor: (appRoot) => permissionFlags(databasePath, appRoot),
      /** Stops the service and keeps it stopped; resolves once it exited. */
      pause() {
        paused = true;
        if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
        if (!running()) return Promise.resolve();
        return new Promise((resolvePause) => { exited.push(resolvePause); stopChild(); });
      },
      /** Starts the service again, from `next` if given. With `onExit`, its
       * exit is reported there instead of restarting it (a trial). */
      resume(next = null, { onExit = null } = {}) {
        if (stopping) return false;
        if (next) spec = next;
        onTrialExit = onExit;
        paused = false;
        start();
        return true;
      },
      /** The trial passed: its exits restart it as usual from now on. */
      endTrial() { onTrialExit = null; },
      /** How the service is started from now on (the release that passed). */
      adopt(next) { spec = next; },
    };
    let finished = false;
    const finish = (code) => {
      finished = true;
      update?.stop();
      copier?.stop();
      if (stopOnStdinClose) {
        stdin.removeListener("end", onStdinClosed);
        stdin.removeListener("error", onStdinClosed);
        // A paused stdin no longer keeps the launcher alive.
        stdin.pause();
      }
      if (log !== null) closeSync(log);
      resolveExit(code);
    };
    // SIGTERM (start.sh, Docker, systemd, launchd) is sent to this launcher
    // only, so it is forwarded. A terminal's Ctrl+C (SIGINT) already reaches
    // the service too, so it is not forwarded again; a SIGINT sent to the
    // launcher alone is passed on as SIGTERM, which the service handles the
    // same way. On Windows nothing is forwarded: there, kill() ends a process
    // without letting it close, and Ctrl+C reaches every process in the
    // console (a supervised service closes when its stdin does instead).
    const forward = (signal) => {
      if (platform === "win32" || !child || child.exitCode !== null) return;
      child.kill(signal);
    };
    const onTerm = () => {
      stopping = true;
      if (restartTimer || (paused && !running())) { if (restartTimer) clearTimeout(restartTimer); finish(0); return; }
      forward("SIGTERM");
    };
    const onInt = () => {
      stopping = true;
      if (restartTimer || (paused && !running())) { if (restartTimer) clearTimeout(restartTimer); finish(130); return; }
      setTimeout(() => { if (child && child.exitCode === null && child.signalCode === null) forward("SIGTERM"); }, 250).unref();
    };
    // The service host closed this launcher's stdin (or ended): close the
    // service's stdin in turn, which it reads as "stop" (KIN_STOP_WITH_LAUNCHER).
    const onStdinClosed = () => {
      if (stopping) return;
      stopping = true;
      if (restartTimer || (paused && !running())) { if (restartTimer) clearTimeout(restartTimer); finish(0); return; }
      if (child && child.exitCode === null && child.signalCode === null) child.stdin?.end();
    };
    signals.on("SIGTERM", onTerm);
    signals.on("SIGINT", onInt);
    if (stopOnStdinClose) {
      stdin.on("end", onStdinClosed);
      stdin.on("error", onStdinClosed);
      stdin.resume();
    }
    const start = () => {
      restartTimer = null;
      const startedAt = Date.now();
      const piped = log !== null;
      child = spawnImpl(spec.command, spec.args, {
        stdio: [stopByPipe ? "pipe" : "inherit", piped || watchCodes ? "pipe" : "inherit", piped ? "pipe" : "inherit"],
        env: spec.env,
        windowsHide: true,
      });
      if (piped) {
        child.stdout?.on("data", (chunk) => { writeSync(log, chunk); if (watchCodes) watch(chunk); });
        child.stderr?.on("data", (chunk) => writeSync(log, chunk));
      } else if (watchCodes) {
        child.stdout?.on("data", (chunk) => { stdout.write(chunk); watch(chunk); });
      }
      child.on("error", (error) => {
        write(process.stderr, JSON.stringify({ event: "startup_failed", outcome: "launch_failed", message: error.message }));
        signals.removeListener("SIGTERM", onTerm);
        signals.removeListener("SIGINT", onInt);
        finish(1);
      });
      // With the output piped to the log, wait for "close" (exit and the
      // pipes drained) so no output arrives after the log is closed.
      child.on(piped || watchCodes ? "close" : "exit", (code, signal) => {
        const exitCode = code ?? 128 + (constants.signals[signal] ?? 0);
        for (const waiter of exited.splice(0)) waiter(exitCode);
        if (paused && !stopping) return;
        if (onTrialExit && !stopping) {
          const report = onTrialExit;
          onTrialExit = null;
          paused = true;
          write(stderr, JSON.stringify({ event: "service_trial_exited", code: exitCode }));
          report(exitCode);
          return;
        }
        // The service asked to be started again (setup wrote its name):
        // at once, supervised or not, unless a stop is under way.
        if (exitCode === RESTART_EXIT_CODE && !stopping) {
          write(stderr, JSON.stringify({ event: "service_restarting", code: exitCode, delayMs: 0, reason: "requested" }));
          restartTimer = setTimeout(start, 0);
          return;
        }
        if (!supervise || stopping || exitCode === 0) {
          signals.removeListener("SIGTERM", onTerm);
          signals.removeListener("SIGINT", onInt);
          finish(exitCode);
          return;
        }
        if (Date.now() - startedAt >= RESTART_RESET_MS) delay = RESTART_MIN_MS;
        write(process.stderr, JSON.stringify({ event: "service_restarting", code: exitCode, delayMs: delay }));
        restartTimer = setTimeout(start, delay);
        delay = Math.min(delay * 2, RESTART_MAX_MS);
      });
    };
    start();
    if (updater) {
      Promise.resolve(updater({ controller, databasePath, env, log: (event) => write(stderr, JSON.stringify(event)) }))
        .then((created) => {
          update = created;
          if (stopping) created?.stop();
          else created?.start();
        })
        .catch((error) => write(stderr, JSON.stringify({ event: "home_update_unavailable", message: error?.message ?? String(error) })));
    }
    // Home mode only: elsewhere nothing reads the service's backup lines.
    if (backupCopy && watchCodes) {
      Promise.resolve(backupCopy({ databasePath, env, log: (event) => write(stderr, JSON.stringify(event)) }))
        .then((created) => {
          copier = created;
          if (stopping || finished) created?.stop();
          else created?.start();
        })
        .catch((error) => write(stderr, JSON.stringify({ event: "home_backup_copy_unavailable", message: error?.message ?? String(error) })));
    }
  });
}

/**
 * The launcher's entry point; resolves with the process exit code.
 *   serviceProcess  how to start the sandboxed service (see runService)
 *   program         how a service manager starts Kin (server/service-install.mjs)
 *   version         Kin's version, for --version
 */
export async function runLauncher(argv, { serviceProcess, program, version, env = process.env, platform = process.platform, stdout = process.stdout, stderr = process.stderr } = {}) {
  let options;
  try {
    options = parseLauncherArguments(argv);
  } catch (error) {
    if (!(error instanceof LauncherUsageError)) throw error;
    stderr.write(`${error.message}\n\n${USAGE}\n`);
    return 2;
  }
  switch (options.command) {
    case "help":
      stdout.write(`${USAGE}\n`);
      return 0;
    case "version":
      stdout.write(`${version}\n`);
      return 0;
    case "health":
      return checkHealth(env);
    case "admin": {
      // Backups and restores write outside the data directory, so the admin
      // commands run here, outside the sandbox, as `node server/admin.mjs`.
      const { runAdminCommand } = await import("./admin.mjs");
      const { DurableStoreError } = await import("./durable-store.mjs");
      try {
        await runAdminCommand(options.adminArgs);
        return 0;
      } catch (error) {
        stderr.write(`${error instanceof DurableStoreError ? error.message : "Kin database operation failed."}\n`);
        return 1;
      }
    }
    case "print-service":
    case "install-service":
    case "uninstall-service": {
      const service = await import("./service-install.mjs");
      try {
        return await service.runServiceCommand(options, { program, env, platform: options.platform ?? platform, stdout, stderr });
      } catch (error) {
        if (!(error instanceof service.ServiceInstallError)) throw error;
        stderr.write(`${error.message}\n`);
        return 1;
      }
    }
    default: {
      // Home mode: the updater (#722). It reads the built-in release key and
      // does nothing without one.
      const home = String(env.KIN_MODE ?? "").trim().toLowerCase() === "home";
      const updater = home && program ? async ({ controller, databasePath, env: serviceEnv, log }) => {
        const { homeUpdater } = await import("./home/updater.mjs");
        return homeUpdater({ controller, program, version, databasePath, env: serviceEnv, log, health: () => checkHealth(env) });
      } : null;
      // And the copy to a second folder (#763), however Kin was started.
      const backupCopy = home ? async ({ databasePath, env: copyEnv, log }) => {
        const { homeBackupCopier } = await import("./home/backup-copy.mjs");
        return homeBackupCopier({ databasePath, env: copyEnv, log });
      } : null;
      return runService({ serviceProcess, env, supervise: options.supervise, stopOnStdinClose: options.stopOnStdinClose, logFile: options.logFile, platform, updater, backupCopy });
    }
  }
}
