// Running Kin as a service that starts with the computer (ADR 0025 §10, #716):
// a systemd unit on Linux, a launchd LaunchDaemon on macOS, and on Windows a
// real Windows service.
//
// Windows: a service registered with sc.exe must answer the Service Control
// Manager, which a console program can't (error 1053). So the program
// Windows starts is Kin's service host, kin-service-host.exe
// (tools/kin-service-host, #749, Rust std only), shipped beside kin.exe. It
// runs `kin.exe --stop-on-stdin-close …` as the low-privilege LOCAL SERVICE
// account, restarts it if it fails, and stops it by closing its stdin, so
// the service closes its database. sc.exe registers it to start at boot and
// to be restarted if the host itself fails.
//
// Without the host (a kin.exe downloaded on its own), install falls back to
// the ADR's alternative from #716: a scheduled task that starts at boot as
// LOCAL SERVICE, with the launcher supervising (restarting) the service
// itself, since Task Scheduler's own restart only covers a task that fails
// to start.
//
// `kin --install-service`, `--uninstall-service` and `--print-service` come
// here from the launcher (server/launcher.mjs), outside the sandbox. Install
// and uninstall need admin rights (sudo, or an elevated prompt on Windows).
// Uninstalling removes the service and Kin's installed copy and never touches
// the data directory.
//
// The account Kin runs as may write its install folder (#722, the owner's
// choice): the launcher replaces the executable there when it updates
// itself (server/home/updater.mjs). The service it starts still runs in the
// sandbox and may write only its data directory. On Linux the folder is
// owned by the "kin" account and named in the unit's ReadWritePaths
// (ProtectSystem=strict makes /usr read-only otherwise); on macOS it is
// owned by the account the LaunchDaemon runs as; on Windows LOCAL SERVICE
// gets modify rights on it.
//
// Each command is first built as a plan (a list of steps), which is what the
// tests check, then carried out step by step.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { homeDataDirectory } from "./mode.mjs";

export const SYSTEMD_UNIT_PATH = "/etc/systemd/system/kin.service";
export const LINUX_INSTALL_DIRECTORY = "/usr/local/lib/kin";
export const LINUX_ACCOUNT = "kin";
export const LAUNCHD_LABEL = "io.journeytocode.kin";
export const LAUNCHD_PLIST_PATH = `/Library/LaunchDaemons/${LAUNCHD_LABEL}.plist`;
export const MACOS_INSTALL_DIRECTORY = "/usr/local/libexec/kin";
export const MACOS_APP_CACHE = "/Library/Caches/Kin";
export const MACOS_LOG_DIRECTORY = "/Library/Logs/Kin";
export const WINDOWS_TASK_NAME = "Kin";
export const WINDOWS_SERVICE_NAME = "Kin";
export const SERVICE_HOST_FILE = "kin-service-host.exe";
// The service gives itself 30 seconds to close its database; the host waits
// 40 before it ends it, as the systemd unit and the launchd plist do.
export const SERVICE_STOP_TIMEOUT_SECONDS = 40;
// How long install and uninstall wait for a running service to stop.
const SERVICE_STOP_WAIT_MS = (SERVICE_STOP_TIMEOUT_SECONDS + 20) * 1000;
// sc.exe takes this name for LOCAL SERVICE in every language.
const LOCAL_SERVICE_ACCOUNT = "NT AUTHORITY\\LocalService";
// Well-known Windows accounts, by SID so they work in every language.
const LOCAL_SERVICE = "*S-1-5-19";
const SYSTEM = "*S-1-5-18";
const ADMINISTRATORS = "*S-1-5-32-544";

export class ServiceInstallError extends Error {
  constructor(message) {
    super(message);
    this.name = "ServiceInstallError";
  }
}

// --- Generated files -------------------------------------------------------

/** One systemd ExecStart= word: quoted when needed, `%` and `$` escaped. */
export function systemdWord(word) {
  const escaped = word.replaceAll("%", "%%").replaceAll("$", "$$$$");
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(escaped)) return escaped;
  return `"${escaped.replace(/[\\"]/g, "\\$&")}"`;
}

/** The systemd unit (kin.service). `execStart` is the program and its
 * arguments; `sea` adds a cache directory for the executable's app files. */
export function systemdUnit({ execStart, sea }) {
  return `# Kin home server (ADR 0025 §10). Installed by \`kin --install-service\`;
# removed by \`kin --uninstall-service\`, which keeps /var/lib/kin.
[Unit]
Description=Kin home server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${LINUX_ACCOUNT}
Group=${LINUX_ACCOUNT}
ExecStart=${execStart.map(systemdWord).join(" ")}
Environment=KIN_MODE=home
Environment=KIN_DATA_DIR=/var/lib/kin
StateDirectory=kin
StateDirectoryMode=0700
${sea ? `# The executable unpacks its app files here (KIN_APP_CACHE).\nCacheDirectory=kin\nCacheDirectoryMode=0700\n# Kin updates its own executable here (#722).\nReadWritePaths=${LINUX_INSTALL_DIRECTORY}\n` : ""}UMask=0077
Restart=on-failure
RestartSec=5
# The service gives itself 30 seconds to close its database.
TimeoutStopSec=40
NoNewPrivileges=yes
ProtectSystem=strict
# The launcher copies each backup to a second folder, such as a USB drive
# mounted under one of these (#763). The service itself still writes only
# its data folder: Node's permission model keeps it there.
ReadWritePaths=-/media -/mnt -/run/media
ProtectHome=${sea ? "yes" : "read-only"}
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
RestrictNamespaces=yes
LockPersonality=yes
SystemCallArchitectures=native
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
CapabilityBoundingSet=
# MemoryDenyWriteExecute stays off: V8's JIT compiler writes code pages.

[Install]
WantedBy=multi-user.target
`;
}

const xml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]);

/** The launchd LaunchDaemon plist. */
export function launchdPlist({ programArguments, userName, environment, logPath }) {
  const strings = (values) => values.map((value) => `    <string>${xml(value)}</string>`).join("\n");
  const variables = Object.entries(environment).map(([name, value]) => `    <key>${xml(name)}</key>\n    <string>${xml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Kin home server (ADR 0025 §10). Kin's install-service command wrote
     this; its uninstall-service command removes it and keeps Kin's data.
     (XML comments can't hold a double hyphen, so no flag names here.) -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings(programArguments)}
  </array>
  <key>UserName</key>
  <string>${xml(userName)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${variables}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ExitTimeOut</key>
  <integer>40</integer>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

/** One Windows command-line argument, quoted as CommandLineToArgvW reads it. */
export function windowsArgument(value) {
  if (value !== "" && !/[\s"]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/** The Task Scheduler task (XML, written to disk as UTF-16 with a BOM). */
export function scheduledTaskXml({ command, args, workingDirectory }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<!-- Kin home server (ADR 0025 §10). Kin's install-service command wrote
     this; its uninstall-service command removes it and keeps Kin's data.
     (XML comments can't hold a double hyphen, so no flag names here.) -->
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Kin home server. Starts when the computer starts.</Description>
    <URI>\\${WINDOWS_TASK_NAME}</URI>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
    </BootTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>S-1-5-19</UserId>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(command)}</Command>
      <Arguments>${xml(args.map(windowsArgument).join(" "))}</Arguments>
      <WorkingDirectory>${xml(workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

// --- Plans -------------------------------------------------------------------

/** Where things go on each platform. */
export function serviceLayout(platform, env = process.env) {
  if (platform === "linux")
    return { dataDirectory: homeDataDirectory("linux", env), installDirectory: LINUX_INSTALL_DIRECTORY, executable: `${LINUX_INSTALL_DIRECTORY}/kin`, definition: SYSTEMD_UNIT_PATH };
  if (platform === "darwin")
    return { dataDirectory: homeDataDirectory("darwin", env), installDirectory: MACOS_INSTALL_DIRECTORY, executable: `${MACOS_INSTALL_DIRECTORY}/kin`, definition: LAUNCHD_PLIST_PATH, appCache: MACOS_APP_CACHE, logDirectory: MACOS_LOG_DIRECTORY };
  if (platform === "win32") {
    const programData = env.ProgramData || env.PROGRAMDATA || "C:\\ProgramData";
    const programFiles = env.ProgramFiles || env.PROGRAMFILES || "C:\\Program Files";
    const dataDirectory = homeDataDirectory("win32", env);
    return {
      dataDirectory,
      installDirectory: win32.join(programFiles, "Kin"),
      executable: win32.join(programFiles, "Kin", "kin.exe"),
      serviceHost: win32.join(programFiles, "Kin", SERVICE_HOST_FILE),
      definition: `Windows service ${WINDOWS_SERVICE_NAME}`,
      taskDefinition: `Task Scheduler task \\${WINDOWS_TASK_NAME}`,
      appCache: win32.join(programData, "Kin-app"),
      logFile: win32.join(dataDirectory, "logs", "kin.log"),
      hostLogFile: win32.join(dataDirectory, "logs", "service-host.log"),
    };
  }
  throw new ServiceInstallError(`Kin can't be installed as a service on ${platform}.`);
}

/** The program a service manager runs, and how it is installed. A single
 * executable is copied to the layout's install directory and run from there;
 * `node server/start.mjs` is run in place. */
function serviceProgram(program, layout) {
  if (program?.kind === "sea") return { command: layout.executable, args: [], copyFrom: program.executable };
  if (program?.kind === "node") return { command: program.command, args: [...program.args], copyFrom: null };
  throw new ServiceInstallError("Kin doesn't know which program to install.");
}

// Debian, Ubuntu, Raspberry Pi OS and Fedora all have it here.
const NOLOGIN = "/usr/sbin/nologin";

// --- The Windows service host ------------------------------------------------

/**
 * The service host to install, or null when there is none (then Windows
 * falls back to a scheduled task). KIN_SERVICE_HOST names one; otherwise it
 * is looked for beside the executable, as kin-service-host.exe or with the
 * executable's own release name (kin-1.6.0-win-x64.exe beside
 * kin-service-host-1.6.0-win-x64.exe), and from a checkout in the host's
 * cargo build folder.
 */
export function findServiceHost({ program, env = process.env, exists = existsSync }) {
  if (env.KIN_SERVICE_HOST) {
    if (!exists(env.KIN_SERVICE_HOST)) throw new ServiceInstallError(`KIN_SERVICE_HOST names ${env.KIN_SERVICE_HOST}, which doesn't exist.`);
    return env.KIN_SERVICE_HOST;
  }
  const candidates = [];
  if (program?.kind === "sea") {
    const directory = win32.dirname(program.executable);
    const name = win32.basename(program.executable);
    candidates.push(win32.join(directory, SERVICE_HOST_FILE));
    if (/^kin-\d/i.test(name)) candidates.push(win32.join(directory, name.replace(/^kin-/i, "kin-service-host-")));
  } else if (program?.kind === "node" && program.args[0]) {
    const root = win32.dirname(win32.dirname(program.args[0]));
    for (const target of ["release", "x86_64-pc-windows-msvc\\release"])
      candidates.push(win32.join(root, "tools", "kin-service-host", "target", target, SERVICE_HOST_FILE));
  }
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

/** The arguments of the launcher the service host runs. */
function windowsLauncherArguments(run, layout, sea, { host }) {
  const args = [...run.args, host ? "--stop-on-stdin-close" : "--supervise", "--log-file", layout.logFile];
  if (sea) args.push("--app-cache", layout.appCache);
  return args;
}

/** The service's command line (sc.exe's binPath): the host, its options,
 * then `--` and the launcher's arguments. */
export function serviceHostCommandLine({ host, program, args, layout }) {
  return [
    host,
    "--program", program,
    "--working-directory", layout.dataDirectory,
    "--env", `KIN_DATA_DIR=${layout.dataDirectory}`,
    "--stop-timeout", String(SERVICE_STOP_TIMEOUT_SECONDS),
    "--log-file", layout.hostLogFile,
    "--",
    ...args,
  ].map(windowsArgument).join(" ");
}

/** The sc.exe commands that register the service and its recovery, as
 * argument lists. `create` is for a new service; `config` sets the same on
 * one that exists (a reinstall). */
export function windowsServiceCommands(commandLine) {
  const settings = ["binPath=", commandLine, "start=", "auto", "obj=", LOCAL_SERVICE_ACCOUNT, "password=", "", "DisplayName=", "Kin home server"];
  return {
    create: ["create", WINDOWS_SERVICE_NAME, ...settings],
    config: ["config", WINDOWS_SERVICE_NAME, ...settings],
    description: ["description", WINDOWS_SERVICE_NAME, "Kin home server: your household's own Kin service. Starts when the computer starts."],
    // If the host itself fails (or stops with an error), Windows starts it
    // again after 5 seconds, then 30, then every minute; the count resets
    // after a day. The host restarts a failing Kin on its own first.
    failure: ["failure", WINDOWS_SERVICE_NAME, "reset=", "86400", "actions=", "restart/5000/restart/30000/restart/60000"],
    failureFlag: ["failureflag", WINDOWS_SERVICE_NAME, "1"],
    start: ["start", WINDOWS_SERVICE_NAME],
  };
}

/** One command as a person would type it, for --print-service. */
const commandText = (command, args) => [command, ...args].map(windowsArgument).join(" ");

/**
 * The service definition text for `platform`: { path, content }.
 */
export function serviceDefinition({ platform, program, env = process.env, user = null, exists = existsSync }) {
  const layout = serviceLayout(platform, env);
  const run = serviceProgram(program, layout);
  if (platform === "linux")
    return { path: layout.definition, content: systemdUnit({ execStart: [run.command, ...run.args], sea: program.kind === "sea" }) };
  if (platform === "darwin")
    return {
      path: layout.definition,
      content: launchdPlist({
        programArguments: [run.command, ...run.args],
        userName: user ?? "<the account that runs Kin>",
        environment: { KIN_MODE: "home", KIN_DATA_DIR: layout.dataDirectory, KIN_APP_CACHE: layout.appCache },
        logPath: posix.join(layout.logDirectory, "kin.log"),
      }),
    };
  const sea = program.kind === "sea";
  const host = findServiceHost({ program, env, exists });
  if (host) {
    const commands = windowsServiceCommands(serviceHostCommandLine({
      host: sea ? layout.serviceHost : host,
      program: run.command,
      args: windowsLauncherArguments(run, layout, sea, { host: true }),
      layout,
    }));
    const lines = [commands.create, commands.description, commands.failure, commands.failureFlag].map((args) => commandText("sc.exe", args));
    return { path: layout.definition, content: `${lines.join("\n")}\n` };
  }
  const args = windowsLauncherArguments(run, layout, sea, { host: false });
  return { path: layout.taskDefinition, content: scheduledTaskXml({ command: run.command, args, workingDirectory: layout.dataDirectory }) };
}

const sameWindowsPath = (left, right) => win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();

/**
 * The steps that install (`action` "install") or remove ("uninstall") the
 * service. Steps: { kind: "admin" | "require" | "mkdir" | "copy" | "write" |
 * "remove" | "task" | "stop-service" | "run", … }; a "run" step with
 * `unless` is skipped when that command succeeds, and one with
 * `allowFailure` may fail. `exists` decides whether the Windows service
 * host is there (findServiceHost).
 */
export function servicePlan(action, { platform, program, env = process.env, user = null, exists = existsSync }) {
  const layout = serviceLayout(platform, env);
  const run = serviceProgram(program, layout);
  const sea = program.kind === "sea";
  const steps = [{ kind: "admin", platform }];
  const notes = [];
  const keep = `Kin's data in ${layout.dataDirectory} was kept. Delete it yourself only if you no longer need it; a backup of it can be used to impersonate this home server.`;

  if (platform === "linux") {
    if (action === "install") {
      steps.push({ kind: "require", path: "/run/systemd/system", message: "This computer doesn't use systemd, so Kin can't install itself as a service here. Run Kin from your own init system instead (docs/HOME-SERVER.md)." });
      steps.push({ kind: "run", command: "useradd", args: ["--system", "--user-group", "--no-create-home", "--home-dir", layout.dataDirectory, "--shell", NOLOGIN, LINUX_ACCOUNT], unless: { command: "id", args: ["-u", LINUX_ACCOUNT] } });
      if (sea) {
        steps.push({ kind: "mkdir", path: layout.installDirectory, mode: 0o755 });
        steps.push({ kind: "copy", from: run.copyFrom, to: layout.executable, mode: 0o755 });
        // Kin updates itself here (#722).
        steps.push({ kind: "run", command: "chown", args: ["-R", `${LINUX_ACCOUNT}:${LINUX_ACCOUNT}`, layout.installDirectory] });
      }
      steps.push({ kind: "write", path: layout.definition, content: serviceDefinition({ platform, program, env }).content, mode: 0o644 });
      steps.push({ kind: "run", command: "systemctl", args: ["daemon-reload"] });
      steps.push({ kind: "run", command: "systemctl", args: ["enable", "kin.service"] });
      steps.push({ kind: "run", command: "systemctl", args: ["restart", "kin.service"] });
      notes.push(`Kin runs as the "${LINUX_ACCOUNT}" account and keeps its data in ${layout.dataDirectory}. Check it with: systemctl status kin; journalctl -u kin`);
    } else {
      steps.push({ kind: "run", command: "systemctl", args: ["disable", "--now", "kin.service"], allowFailure: true });
      steps.push({ kind: "remove", path: layout.definition });
      steps.push({ kind: "run", command: "systemctl", args: ["daemon-reload"], allowFailure: true });
      if (sea) steps.push({ kind: "remove", path: layout.installDirectory, recursive: true });
      notes.push(keep, `The "${LINUX_ACCOUNT}" account was kept too, so the data keeps its owner (remove it with: userdel ${LINUX_ACCOUNT}).`);
    }
    return { steps, notes, layout };
  }

  if (platform === "darwin") {
    const account = user ?? env.SUDO_USER ?? null;
    if (action === "install") {
      if (!account || account === "root")
        throw new ServiceInstallError("Run the install with sudo from the account Kin should run as, or name it with --user. Kin doesn't run as root.");
      if (sea) {
        steps.push({ kind: "mkdir", path: layout.installDirectory, mode: 0o755 });
        steps.push({ kind: "copy", from: run.copyFrom, to: layout.executable, mode: 0o755 });
        // The copy keeps the download's quarantine flag, which would stop
        // launchd from starting an unsigned program. The person already chose
        // to open this one (docs/HOME-SERVER.md, unsigned builds).
        steps.push({ kind: "run", command: "xattr", args: ["-d", "com.apple.quarantine", layout.executable], allowFailure: true });
        // Kin updates itself here (#722).
        steps.push({ kind: "run", command: "chown", args: ["-R", account, layout.installDirectory] });
      }
      for (const path of [layout.dataDirectory, layout.appCache, layout.logDirectory]) {
        steps.push({ kind: "mkdir", path, mode: 0o700 });
        steps.push({ kind: "run", command: "chown", args: [account, path] });
      }
      steps.push({ kind: "write", path: layout.definition, content: serviceDefinition({ platform, program, env, user: account }).content, mode: 0o644 });
      steps.push({ kind: "run", command: "launchctl", args: ["bootout", `system/${LAUNCHD_LABEL}`], allowFailure: true });
      steps.push({ kind: "run", command: "launchctl", args: ["bootstrap", "system", layout.definition] });
      notes.push(`Kin runs as ${account} and keeps its data in ${layout.dataDirectory}. Its log is ${posix.join(layout.logDirectory, "kin.log")}.`);
    } else {
      steps.push({ kind: "run", command: "launchctl", args: ["bootout", `system/${LAUNCHD_LABEL}`], allowFailure: true });
      steps.push({ kind: "remove", path: layout.definition });
      if (sea) steps.push({ kind: "remove", path: layout.installDirectory, recursive: true });
      notes.push(keep);
    }
    return { steps, notes, layout };
  }

  // Windows: a service run by the service host, or the scheduled-task
  // fallback without one (see the top of this file). Either install first
  // stops and removes what an earlier install left running, so files can be
  // replaced and Kin never runs twice.
  const stopService = { kind: "stop-service", name: WINDOWS_SERVICE_NAME, timeoutMs: SERVICE_STOP_WAIT_MS };
  const removeTask = [
    { kind: "run", command: "schtasks", args: ["/End", "/TN", WINDOWS_TASK_NAME], allowFailure: true },
    { kind: "run", command: "schtasks", args: ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"], allowFailure: true },
  ];
  const deleteService = { kind: "run", command: "sc.exe", args: ["delete", WINDOWS_SERVICE_NAME], allowFailure: true };
  if (action === "install") {
    const host = findServiceHost({ program, env, exists });
    steps.push(stopService);
    if (host) steps.push(...removeTask);
    else steps.push(deleteService, removeTask[0]);
    for (const path of [layout.dataDirectory, layout.appCache]) {
      steps.push({ kind: "mkdir", path });
      // Only LOCAL SERVICE (which runs Kin), SYSTEM and Administrators.
      steps.push({ kind: "run", command: "icacls", args: [path, "/inheritance:r", "/grant:r", `${SYSTEM}:(OI)(CI)F`, `${ADMINISTRATORS}:(OI)(CI)F`, `${LOCAL_SERVICE}:(OI)(CI)M`] });
    }
    if (sea) {
      steps.push({ kind: "mkdir", path: layout.installDirectory });
      // Reinstalling from the installed copy leaves it where it is.
      if (!sameWindowsPath(run.copyFrom, layout.executable)) steps.push({ kind: "copy", from: run.copyFrom, to: layout.executable });
      if (host && !sameWindowsPath(host, layout.serviceHost)) steps.push({ kind: "copy", from: host, to: layout.serviceHost });
      // Kin updates itself here (#722). The service host runs as LOCAL
      // SERVICE too, so this gives that account nothing it didn't have.
      steps.push({ kind: "run", command: "icacls", args: [layout.installDirectory, "/grant", `${LOCAL_SERVICE}:(OI)(CI)M`] });
    }
    if (host) {
      const commands = windowsServiceCommands(serviceHostCommandLine({
        host: sea ? layout.serviceHost : host,
        program: run.command,
        args: windowsLauncherArguments(run, layout, sea, { host: true }),
        layout,
      }));
      steps.push({ kind: "run", command: "sc.exe", args: commands.create, unless: { command: "sc.exe", args: ["query", WINDOWS_SERVICE_NAME] } });
      steps.push({ kind: "run", command: "sc.exe", args: commands.config });
      for (const args of [commands.description, commands.failure, commands.failureFlag, commands.start])
        steps.push({ kind: "run", command: "sc.exe", args });
      notes.push(`Kin runs as the Windows service "${WINDOWS_SERVICE_NAME}" under the LOCAL SERVICE account, starts with Windows and keeps its data in ${layout.dataDirectory}. Its logs are ${layout.logFile} and ${layout.hostLogFile}. Check it with: sc.exe query ${WINDOWS_SERVICE_NAME}`);
    } else {
      steps.push({ kind: "task", content: serviceDefinition({ platform, program, env, exists }).content });
      steps.push({ kind: "run", command: "schtasks", args: ["/Run", "/TN", WINDOWS_TASK_NAME] });
      notes.push(
        `Kin starts with Windows as the LOCAL SERVICE account and keeps its data in ${layout.dataDirectory}. Its log is ${layout.logFile}.`,
        `${SERVICE_HOST_FILE} wasn't found beside ${sea ? win32.basename(program.executable) : "Kin"}, so Kin starts from a scheduled task instead of a Windows service. Put it beside kin.exe and install again to use a service (docs/HOME-SERVER.md).`,
      );
    }
  } else {
    steps.push(stopService, deleteService, ...removeTask);
    // Windows can't delete a running program: uninstalling from the
    // installed copy itself leaves that folder for the person to delete.
    if (sea) steps.push({ kind: "remove", path: layout.installDirectory, recursive: true, allowFailure: true });
    notes.push(keep);
  }
  return { steps, notes, layout };
}

// --- Carrying a plan out ---------------------------------------------------

function defaultRun(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  return { code: result.error ? -1 : result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? result.error?.message ?? "" };
}

// A blocking pause: install and uninstall are synchronous command-line steps.
function defaultSleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

// sc.exe query's "STATE : 1  STOPPED" (the number is the same in every
// language); null when the output has none.
export function serviceState(output) {
  const match = /STATE\s*:\s*(\d+)/.exec(output);
  return match ? Number(match[1]) : null;
}
const SERVICE_STOPPED = 1;

function defaultIsAdmin(platform, run) {
  if (platform === "win32") return run("net", ["session"]).code === 0;
  return process.getuid?.() === 0;
}

/** Carries out a plan's steps in order; stops at the first failure. */
export function executePlan(plan, { run = defaultRun, isAdmin = defaultIsAdmin, log = () => {}, sleep = defaultSleep, now = Date.now, fs = { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } } = {}) {
  for (const step of plan.steps) {
    switch (step.kind) {
      case "admin":
        if (!isAdmin(step.platform, run))
          throw new ServiceInstallError(step.platform === "win32"
            ? "Installing a service needs an administrator. Open the command prompt with \"Run as administrator\" and try again."
            : "Installing a service needs admin rights. Run the same command with sudo.");
        break;
      case "require":
        if (!fs.existsSync(step.path)) throw new ServiceInstallError(step.message);
        break;
      case "mkdir":
        log(`Creating ${step.path}`);
        fs.mkdirSync(step.path, { recursive: true, ...(step.mode ? { mode: step.mode } : {}) });
        if (step.mode) fs.chmodSync(step.path, step.mode);
        break;
      case "copy": {
        // Copied beside the target and renamed over it, so reinstalling over
        // a running copy works and a failed copy leaves the old one.
        log(`Installing ${step.to}`);
        const next = `${step.to}.new`;
        fs.copyFileSync(step.from, next);
        if (step.mode) fs.chmodSync(next, step.mode);
        fs.renameSync(next, step.to);
        break;
      }
      case "write":
        log(`Writing ${step.path}`);
        fs.writeFileSync(step.path, step.content, { mode: step.mode });
        if (step.mode) fs.chmodSync(step.path, step.mode);
        break;
      case "remove":
        log(`Removing ${step.path}`);
        try {
          fs.rmSync(step.path, { recursive: step.recursive === true, force: true });
        } catch (error) {
          if (!step.allowFailure) throw error;
          log(`Couldn't remove ${step.path} (${error.code ?? error.message}); delete it yourself once Kin has stopped.`);
        }
        break;
      case "task": {
        // schtasks reads the definition from a file, in UTF-16 with a BOM.
        const file = join(tmpdir(), `kin-task-${randomBytes(6).toString("hex")}.xml`);
        fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(step.content, "utf16le")]));
        try {
          log(`Registering the scheduled task ${WINDOWS_TASK_NAME}`);
          const result = run("schtasks", ["/Create", "/TN", WINDOWS_TASK_NAME, "/XML", file, "/F"]);
          if (result.code !== 0) throw new ServiceInstallError(`schtasks /Create failed: ${(result.stderr || result.stdout).trim()}`);
        } finally {
          fs.rmSync(file, { force: true });
        }
        break;
      }
      case "stop-service": {
        // Asks a running service to stop and waits until it has (the host
        // gives Kin time to close its database); nothing to do when it isn't
        // installed or already stopped.
        const query = () => run("sc.exe", ["query", step.name]);
        let state = query();
        if (state.code !== 0 || serviceState(state.stdout) === SERVICE_STOPPED) break;
        log(`Stopping the ${step.name} service`);
        run("sc.exe", ["stop", step.name]);
        const deadline = now() + step.timeoutMs;
        for (;;) {
          state = query();
          const current = serviceState(state.stdout);
          if (state.code !== 0 || current === null || current === SERVICE_STOPPED) break;
          if (now() >= deadline)
            throw new ServiceInstallError(`The ${step.name} service didn't stop within ${Math.round(step.timeoutMs / 1000)} seconds. Stop it in Services (services.msc) and try again.`);
          sleep(500);
        }
        break;
      }
      case "run": {
        if (step.unless && run(step.unless.command, step.unless.args).code === 0) break;
        const line = [step.command, ...step.args].join(" ");
        log(`Running ${line}`);
        const result = run(step.command, step.args);
        if (result.code !== 0 && !step.allowFailure)
          throw new ServiceInstallError(`${line} failed${result.stderr || result.stdout ? `: ${(result.stderr || result.stdout).trim()}` : "."}`);
        break;
      }
      default:
        throw new ServiceInstallError(`Unknown install step ${step.kind}.`);
    }
  }
}

/** The launcher's --print-service, --install-service and --uninstall-service. */
export async function runServiceCommand(options, { program, env = process.env, platform = process.platform, stdout = process.stdout, run, isAdmin, fs } = {}) {
  if (options.command === "print-service") {
    const user = platform === "darwin" ? options.user ?? env.SUDO_USER ?? env.USER ?? null : null;
    const definition = serviceDefinition({ platform, program, env, user, ...(fs?.existsSync ? { exists: fs.existsSync } : {}) });
    stdout.write(`# ${definition.path}\n${definition.content}`);
    return 0;
  }
  const plan = servicePlan(options.command === "install-service" ? "install" : "uninstall", { platform, program, env, user: options.user, ...(fs?.existsSync ? { exists: fs.existsSync } : {}) });
  executePlan(plan, { run, isAdmin, fs, log: (line) => stdout.write(`${line}\n`) });
  stdout.write(`${options.command === "install-service" ? "Kin is installed as a service." : "The Kin service is removed."}\n`);
  for (const note of plan.notes) stdout.write(`${note}\n`);
  return 0;
}
