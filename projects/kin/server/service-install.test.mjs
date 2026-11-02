// Running Kin as a service (#716, #749, ADR 0025 §10): the generated systemd
// unit, launchd plist, Windows service (sc.exe and the service host) and its
// scheduled-task fallback, the install and uninstall plans (uninstall never
// touches the data directory) and carrying a plan out.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { APP_ROOT } from "./permissions.mjs";
import {
  executePlan, findServiceHost, LAUNCHD_PLIST_PATH, launchdPlist, runServiceCommand, scheduledTaskXml, ServiceInstallError,
  serviceDefinition, serviceHostCommandLine, serviceLayout, servicePlan, serviceState, SYSTEMD_UNIT_PATH, systemdUnit,
  systemdWord, windowsArgument,
} from "./service-install.mjs";

const SEA = { kind: "sea", executable: "/home/mikey/Downloads/kin-1.6.0-linux-x64" };
const NODE = { kind: "node", command: "/usr/bin/node", args: ["/opt/kin app/server/start.mjs"] };
const WINDOWS_ENV = { ProgramData: "C:\\ProgramData", ProgramFiles: "C:\\Program Files" };
// Whether a file exists, for the tests that decide between the service host
// and the scheduled task: none, or only the files named.
const NOTHING = () => false;
const only = (...files) => (path) => files.includes(path);

// XML comments may not contain "--" (a parser rejects the whole file).
function assertXmlComments(text) {
  for (const [, body] of text.matchAll(/<!--([\s\S]*?)-->/g)) assert.ok(!body.includes("--"), `comment holds "--": ${body}`);
}

test("systemd words are quoted and escaped as systemd reads them", { timeout: 60_000 }, () => {
  assert.equal(systemdWord("/usr/local/lib/kin/kin"), "/usr/local/lib/kin/kin");
  assert.equal(systemdWord("/opt/kin app/start.mjs"), '"/opt/kin app/start.mjs"');
  assert.equal(systemdWord("50%"), "50%%");
  assert.equal(systemdWord("$HOME"), '"$$HOME"');
  assert.equal(systemdWord('a"b\\c'), '"a\\"b\\\\c"');
});

test("the systemd unit runs Kin as the kin account, hardened, restarting on failure", { timeout: 60_000 }, () => {
  const unit = systemdUnit({ execStart: ["/usr/local/lib/kin/kin"], sea: true });
  for (const line of [
    "User=kin", "Group=kin", "ExecStart=/usr/local/lib/kin/kin", "Environment=KIN_MODE=home", "Environment=KIN_DATA_DIR=/var/lib/kin",
    "StateDirectory=kin", "StateDirectoryMode=0700", "CacheDirectory=kin", "UMask=0077", "Restart=on-failure", "NoNewPrivileges=yes",
    "ProtectSystem=strict", "ProtectHome=yes", "WantedBy=multi-user.target", "After=network-online.target",
    "ReadWritePaths=/usr/local/lib/kin",
  ])
    assert.ok(unit.split("\n").includes(line), line);
  assert.ok(!/^MemoryDenyWriteExecute=/m.test(unit), "V8's JIT needs writable code");
  const node = systemdUnit({ execStart: [NODE.command, ...NODE.args], sea: false });
  assert.ok(node.includes('ExecStart=/usr/bin/node "/opt/kin app/server/start.mjs"'));
  assert.ok(node.includes("ProtectHome=read-only"));
  assert.ok(!node.includes("CacheDirectory="));
});

test("the systemd unit lets the launcher write removable drives for the second backup folder (#763)", { timeout: 60_000 }, () => {
  for (const sea of [true, false]) {
    const lines = systemdUnit({ execStart: ["/usr/local/lib/kin/kin"], sea }).split("\n");
    assert.ok(lines.includes("ReadWritePaths=-/media -/mnt -/run/media"), String(sea));
    assert.ok(lines.includes("ProtectSystem=strict"), "the rest of the system stays read-only");
  }
});

test("systemd accepts the unit", { timeout: 60_000 }, (t) => {
  if (process.platform !== "linux") { t.skip("systemd is Linux only"); return; }
  const analyze = spawnSync("systemd-analyze", ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (analyze.status !== 0) { t.skip("systemd-analyze isn't available"); return; }
  const directory = mkdtempSync(join(tmpdir(), "kin-unit-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "kin.service");
  // A node install's ExecStart names files that exist here.
  writeFileSync(path, serviceDefinition({ platform: "linux", program: { kind: "node", command: process.execPath, args: [join(APP_ROOT, "server", "start.mjs")] } }).content);
  const result = spawnSync("systemd-analyze", ["verify", path], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr.split("\n").filter((line) => line.includes("kin.service")).join("\n"), "");
});

test("the LaunchDaemon plist starts Kin at boot as the installing user", { timeout: 60_000 }, () => {
  const plist = launchdPlist({
    programArguments: ["/usr/local/libexec/kin/kin"],
    userName: "mikey",
    environment: { KIN_MODE: "home", KIN_DATA_DIR: "/Library/Application Support/Kin & Co" },
    logPath: "/Library/Logs/Kin/kin.log",
  });
  assertXmlComments(plist);
  assert.match(plist, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<!DOCTYPE plist/);
  assert.match(plist, /<key>Label<\/key>\n {2}<string>io\.journeytocode\.kin<\/string>/);
  assert.match(plist, /<key>UserName<\/key>\n {2}<string>mikey<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\n {2}<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\n {2}<true\/>/);
  assert.match(plist, /<key>Umask<\/key>\n {2}<integer>63<\/integer>/);
  assert.ok(plist.includes("<string>/Library/Application Support/Kin &amp; Co</string>"));
  const python = process.platform === "win32" ? { status: null } : spawnSync("python3", ["-I", "-c", "import plistlib,sys,json; print(json.dumps(plistlib.loads(sys.stdin.buffer.read())))"], { input: plist, encoding: "utf8", timeout: 20_000 });
  // Not on Windows: "python3" there can be the Microsoft Store stub.
  if (process.platform !== "win32" && python.status === 0) {
    const parsed = JSON.parse(python.stdout);
    assert.deepEqual(parsed.ProgramArguments, ["/usr/local/libexec/kin/kin"]);
    assert.equal(parsed.EnvironmentVariables.KIN_DATA_DIR, "/Library/Application Support/Kin & Co");
  }
});

test("Windows arguments are quoted as CommandLineToArgvW reads them", { timeout: 60_000 }, () => {
  assert.equal(windowsArgument("--supervise"), "--supervise");
  assert.equal(windowsArgument("C:\\ProgramData\\Kin\\logs\\kin.log"), "C:\\ProgramData\\Kin\\logs\\kin.log");
  assert.equal(windowsArgument("C:\\Program Files\\Kin"), '"C:\\Program Files\\Kin"');
  assert.equal(windowsArgument("C:\\Program Files\\Kin\\"), '"C:\\Program Files\\Kin\\\\"');
  assert.equal(windowsArgument('say "hi"'), '"say \\"hi\\""');
  assert.equal(windowsArgument(""), '""');
});

test("the scheduled task starts at boot as LOCAL SERVICE with no time limit", { timeout: 60_000 }, () => {
  const task = scheduledTaskXml({ command: "C:\\Program Files\\Kin\\kin.exe", args: ["--supervise", "--log-file", "C:\\Data Dir\\kin.log"], workingDirectory: "C:\\ProgramData\\Kin" });
  assertXmlComments(task);
  assert.match(task, /<BootTrigger>\s*<Enabled>true<\/Enabled>/);
  assert.match(task, /<UserId>S-1-5-19<\/UserId>/);
  assert.match(task, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  // The default is three days, after which Windows would stop Kin.
  assert.match(task, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(task, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  assert.match(task, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.ok(task.includes("<Command>C:\\Program Files\\Kin\\kin.exe</Command>"));
  assert.ok(task.includes("<Arguments>--supervise --log-file &quot;C:\\Data Dir\\kin.log&quot;</Arguments>"));
});

test("each platform's definition names its file and the program to run", { timeout: 60_000 }, () => {
  assert.equal(serviceDefinition({ platform: "linux", program: SEA }).path, SYSTEMD_UNIT_PATH);
  assert.match(serviceDefinition({ platform: "linux", program: SEA }).content, /^ExecStart=\/usr\/local\/lib\/kin\/kin$/m);
  const mac = serviceDefinition({ platform: "darwin", program: SEA, user: "mikey" });
  assert.equal(mac.path, LAUNCHD_PLIST_PATH);
  assert.ok(mac.content.includes("<string>/usr/local/libexec/kin/kin</string>"));
  assert.ok(mac.content.includes("<key>KIN_APP_CACHE</key>\n    <string>/Library/Caches/Kin</string>"));
  const windows = serviceDefinition({ platform: "win32", program: { kind: "sea", executable: "C:\\Users\\m\\Downloads\\kin.exe" }, env: WINDOWS_ENV, exists: NOTHING });
  assert.equal(windows.path, "Task Scheduler task \\Kin");
  assert.ok(windows.content.includes("<Command>C:\\Program Files\\Kin\\kin.exe</Command>"));
  assert.ok(windows.content.includes("<Arguments>--supervise --log-file C:\\ProgramData\\Kin\\logs\\kin.log --app-cache C:\\ProgramData\\Kin-app</Arguments>"));
  assert.ok(windows.content.includes("<WorkingDirectory>C:\\ProgramData\\Kin</WorkingDirectory>"));
  const windowsNode = serviceDefinition({ platform: "win32", program: { kind: "node", command: "C:\\node\\node.exe", args: ["C:\\kin\\server\\start.mjs"] }, env: WINDOWS_ENV, exists: NOTHING });
  assert.ok(windowsNode.content.includes("<Arguments>C:\\kin\\server\\start.mjs --supervise --log-file C:\\ProgramData\\Kin\\logs\\kin.log</Arguments>"));
  assert.throws(() => serviceLayout("aix"), ServiceInstallError);
  assert.throws(() => serviceDefinition({ platform: "linux", program: null }), ServiceInstallError);
});

// Every step that removes something, and the data directory it must spare.
function assertKeepsData(plan) {
  const data = plan.layout.dataDirectory;
  for (const step of plan.steps.filter(({ kind }) => kind === "remove")) {
    assert.ok(!data.startsWith(step.path), `${step.path} would remove ${data}`);
    assert.ok(!step.path.startsWith(data), `${step.path} is inside ${data}`);
  }
  assert.ok(!plan.steps.some(({ kind, args = [] }) => kind === "run" && args.some((arg) => arg.startsWith(data))), "no command touches the data");
  assert.ok(plan.notes.some((note) => note.includes(data) && note.includes("kept")));
}

test("Linux: install creates the account, copies the executable, writes the unit and starts it", { timeout: 60_000 }, () => {
  const plan = servicePlan("install", { platform: "linux", program: SEA });
  assert.deepEqual(plan.steps.map(({ kind, command, path, to }) => [kind, command ?? path ?? to ?? null]), [
    ["admin", null],
    ["require", "/run/systemd/system"],
    ["run", "useradd"],
    ["mkdir", "/usr/local/lib/kin"],
    ["copy", "/usr/local/lib/kin/kin"],
    ["run", "chown"],
    ["write", SYSTEMD_UNIT_PATH],
    ["run", "systemctl"],
    ["run", "systemctl"],
    ["run", "systemctl"],
  ]);
  assert.deepEqual(plan.steps[5].args, ["-R", "kin:kin", "/usr/local/lib/kin"], "the kin account updates its own executable (#722)");
  const user = plan.steps[2];
  assert.deepEqual(user.unless, { command: "id", args: ["-u", "kin"] });
  assert.ok(user.args.includes("--system") && user.args.at(-1) === "kin");
  assert.equal(plan.steps[4].from, SEA.executable);
  assert.deepEqual(plan.steps.slice(7).map(({ args }) => args.join(" ")), ["daemon-reload", "enable kin.service", "restart kin.service"]);
  // From a checkout, node runs Kin in place: nothing is copied.
  assert.ok(!servicePlan("install", { platform: "linux", program: NODE }).steps.some(({ kind }) => kind === "copy" || kind === "mkdir"));
});

test("Linux: uninstall stops and removes the service and the executable, never the data", { timeout: 60_000 }, () => {
  const plan = servicePlan("uninstall", { platform: "linux", program: SEA });
  assert.deepEqual(plan.steps.filter(({ kind }) => kind === "remove").map(({ path }) => path), [SYSTEMD_UNIT_PATH, "/usr/local/lib/kin"]);
  assert.deepEqual(plan.steps[1], { kind: "run", command: "systemctl", args: ["disable", "--now", "kin.service"], allowFailure: true });
  assertKeepsData(plan);
  assertKeepsData(servicePlan("uninstall", { platform: "linux", program: NODE }));
});

test("macOS: install runs Kin as the sudo user, never root, and uninstall keeps the data", { timeout: 60_000 }, () => {
  assert.throws(() => servicePlan("install", { platform: "darwin", program: SEA, env: {} }), /--user/);
  assert.throws(() => servicePlan("install", { platform: "darwin", program: SEA, env: { SUDO_USER: "root" } }), /doesn't run as root/);
  const plan = servicePlan("install", { platform: "darwin", program: SEA, env: { SUDO_USER: "mikey" } });
  const chowned = plan.steps.filter(({ command }) => command === "chown").map(({ args }) => args.join(" "));
  assert.deepEqual(chowned, ["-R mikey /usr/local/libexec/kin", "mikey /Library/Application Support/Kin", "mikey /Library/Caches/Kin", "mikey /Library/Logs/Kin"]);
  assert.ok(plan.steps.some(({ kind, path, mode }) => kind === "mkdir" && path === "/Library/Application Support/Kin" && mode === 0o700));
  const written = plan.steps.find(({ kind }) => kind === "write");
  assert.equal(written.path, LAUNCHD_PLIST_PATH);
  assert.ok(written.content.includes("<string>mikey</string>"));
  assert.deepEqual(plan.steps.at(-1), { kind: "run", command: "launchctl", args: ["bootstrap", "system", LAUNCHD_PLIST_PATH] });
  assert.equal(servicePlan("install", { platform: "darwin", program: SEA, env: { SUDO_USER: "mikey" }, user: "kin" }).steps.find(({ command }) => command === "chown").args[1], "kin");
  assertKeepsData(servicePlan("uninstall", { platform: "darwin", program: SEA, env: {} }));
});

test("Windows without the service host: install limits the folders to LOCAL SERVICE and admins and registers the task; uninstall keeps the data", { timeout: 60_000 }, () => {
  const plan = servicePlan("install", { platform: "win32", program: { kind: "sea", executable: "C:\\Downloads\\kin.exe" }, env: WINDOWS_ENV, exists: NOTHING });
  const acls = plan.steps.filter(({ command }) => command === "icacls");
  assert.deepEqual(acls.map(({ args }) => args[0]), ["C:\\ProgramData\\Kin", "C:\\ProgramData\\Kin-app", "C:\\Program Files\\Kin"]);
  // The install folder keeps its inherited rights; LOCAL SERVICE may also
  // change it, to update Kin (#722).
  assert.deepEqual(acls[2].args.slice(1), ["/grant", "*S-1-5-19:(OI)(CI)M"]);
  for (const { args } of acls.slice(0, 2))
    assert.deepEqual(args.slice(1), ["/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F", "*S-1-5-19:(OI)(CI)M"]);
  assert.ok(plan.steps.some(({ kind, to }) => kind === "copy" && to === "C:\\Program Files\\Kin\\kin.exe"));
  assert.ok(plan.steps.find(({ kind }) => kind === "task").content.includes("<UserId>S-1-5-19</UserId>"));
  assert.deepEqual(plan.steps.at(-1), { kind: "run", command: "schtasks", args: ["/Run", "/TN", "Kin"] });
  // A service from an earlier install is stopped and removed, so Kin never runs twice.
  assert.equal(plan.steps[1].kind, "stop-service");
  assert.ok(plan.steps.some(({ command, args }) => command === "sc.exe" && args.join(" ") === "delete Kin"));
  assert.ok(plan.notes.some((note) => note.includes("kin-service-host.exe wasn't found beside kin.exe")));
  const uninstall = servicePlan("uninstall", { platform: "win32", program: { kind: "sea", executable: "C:\\Program Files\\Kin\\kin.exe" }, env: WINDOWS_ENV, exists: NOTHING });
  assert.deepEqual(uninstall.steps.filter(({ command }) => command === "schtasks").map(({ args }) => args[0]), ["/End", "/Delete"]);
  assert.equal(uninstall.steps.find(({ kind }) => kind === "remove").allowFailure, true);
  assertKeepsData(uninstall);
});

test("a plan is carried out in order: admin check, skips, allowed failures and files", { timeout: 60_000 }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "kin-plan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "source"), "executable");
  const commands = [];
  const run = (command, args) => {
    commands.push([command, ...args].join(" "));
    if (command === "id") return { code: 0, stdout: "998\n", stderr: "" };
    if (command === "broken") return { code: 1, stdout: "", stderr: "it broke\n" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const plan = { steps: [
    { kind: "admin", platform: "linux" },
    { kind: "run", command: "useradd", args: ["kin"], unless: { command: "id", args: ["-u", "kin"] } },
    { kind: "mkdir", path: join(root, "lib", "kin"), mode: 0o755 },
    { kind: "copy", from: join(root, "source"), to: join(root, "lib", "kin", "kin"), mode: 0o755 },
    { kind: "write", path: join(root, "kin.service"), content: "[Unit]\n", mode: 0o644 },
    { kind: "run", command: "broken", args: ["--maybe"], allowFailure: true },
    { kind: "remove", path: join(root, "gone"), recursive: true },
  ] };
  assert.throws(() => executePlan(plan, { run, isAdmin: () => false }), /sudo/);
  assert.deepEqual(commands, []);
  const lines = [];
  executePlan(plan, { run, isAdmin: () => true, log: (line) => lines.push(line) });
  assert.deepEqual(commands, ["id -u kin", "broken --maybe"], "useradd is skipped when the account exists");
  assert.equal(readFileSync(join(root, "lib", "kin", "kin"), "utf8"), "executable");
  assert.ok(!existsSync(join(root, "lib", "kin", "kin.new")));
  assert.equal(readFileSync(join(root, "kin.service"), "utf8"), "[Unit]\n");
  if (process.platform !== "win32") {
    assert.equal(statSync(join(root, "lib", "kin", "kin")).mode & 0o777, 0o755);
    assert.equal(statSync(join(root, "kin.service")).mode & 0o777, 0o644);
  }
  assert.ok(lines.some((line) => line.startsWith("Installing ")));
  assert.throws(() => executePlan({ steps: [{ kind: "run", command: "broken", args: [] }] }, { run, isAdmin: () => true }), { message: "broken failed: it broke" });
  assert.throws(() => executePlan({ steps: [{ kind: "require", path: join(root, "missing"), message: "no systemd" }] }, { run }), /no systemd/);
  mkdirSync(join(root, "busy"));
  const failingFs = { rmSync: () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); } };
  executePlan({ steps: [{ kind: "remove", path: join(root, "busy"), allowFailure: true }] }, { run, fs: failingFs, log: (line) => lines.push(line) });
  assert.ok(lines.at(-1).includes("Couldn't remove"));
  assert.throws(() => executePlan({ steps: [{ kind: "remove", path: join(root, "busy") }] }, { run, fs: failingFs }), /busy/);
});

test("the scheduled task is registered from a UTF-16 file that is removed afterwards", { timeout: 60_000 }, () => {
  let registered = null;
  const run = (command, args) => {
    const file = args[args.indexOf("/XML") + 1];
    const bytes = readFileSync(file);
    registered = { command, args, bom: [...bytes.subarray(0, 2)], text: bytes.subarray(2).toString("utf16le"), file };
    return { code: 0, stdout: "", stderr: "" };
  };
  executePlan({ steps: [{ kind: "task", content: "<Task/>" }] }, { run, isAdmin: () => true });
  assert.equal(registered.command, "schtasks");
  assert.deepEqual(registered.args.slice(0, 2), ["/Create", "/TN"]);
  assert.deepEqual(registered.bom, [0xff, 0xfe]);
  assert.equal(registered.text, "<Task/>");
  assert.ok(!existsSync(registered.file));
  assert.throws(() => executePlan({ steps: [{ kind: "task", content: "<Task/>" }] }, { run: () => ({ code: 1, stdout: "", stderr: "Access is denied." }) }), /Access is denied/);
});

// CommandLineToArgvW's rules (which Rust's std::env::args follows on
// Windows): how the service host will read its command line back.
function windowsArgv(line) {
  const args = [];
  let index = 0;
  while (index < line.length) {
    while (line[index] === " " || line[index] === "\t") index += 1;
    if (index >= line.length) break;
    let arg = "";
    let quoted = false;
    for (; index < line.length; index += 1) {
      const character = line[index];
      if (!quoted && (character === " " || character === "\t")) break;
      if (character === "\\") {
        let slashes = 0;
        while (line[index] === "\\") { slashes += 1; index += 1; }
        if (line[index] === '"') { arg += "\\".repeat(Math.floor(slashes / 2)); if (slashes % 2) arg += '"'; else { quoted = !quoted; } }
        else { arg += "\\".repeat(slashes); index -= 1; }
      } else if (character === '"') {
        if (quoted && line[index + 1] === '"') { arg += '"'; index += 1; } else quoted = !quoted;
      } else arg += character;
    }
    args.push(arg);
  }
  return args;
}

const DOWNLOADED = { kind: "sea", executable: "C:\\Users\\m\\Downloads\\kin-1.6.0-win-x64.exe" };
const INSTALLED = { kind: "sea", executable: "C:\\Program Files\\Kin\\kin.exe" };

test("the service host is found beside the executable, in a checkout, or where KIN_SERVICE_HOST says", { timeout: 60_000 }, () => {
  const plain = "C:\\Users\\m\\Downloads\\kin-service-host.exe";
  const released = "C:\\Users\\m\\Downloads\\kin-service-host-1.6.0-win-x64.exe";
  assert.equal(findServiceHost({ program: DOWNLOADED, env: {}, exists: only(plain, released) }), plain);
  assert.equal(findServiceHost({ program: DOWNLOADED, env: {}, exists: only(released) }), released);
  assert.equal(findServiceHost({ program: DOWNLOADED, env: {}, exists: NOTHING }), null);
  assert.equal(findServiceHost({ program: INSTALLED, env: {}, exists: only("C:\\Program Files\\Kin\\kin-service-host.exe") }), "C:\\Program Files\\Kin\\kin-service-host.exe");
  const built = "C:\\src\\kin\\tools\\kin-service-host\\target\\release\\kin-service-host.exe";
  assert.equal(findServiceHost({ program: { kind: "node", command: "C:\\node\\node.exe", args: ["C:\\src\\kin\\server\\start.mjs"] }, env: {}, exists: only(built) }), built);
  assert.equal(findServiceHost({ program: DOWNLOADED, env: { KIN_SERVICE_HOST: "D:\\host.exe" }, exists: only("D:\\host.exe") }), "D:\\host.exe");
  assert.throws(() => findServiceHost({ program: DOWNLOADED, env: { KIN_SERVICE_HOST: "D:\\missing.exe" }, exists: NOTHING }), /KIN_SERVICE_HOST names D:\\missing\.exe/);
});

test("the service's command line reads back as the host's options and the launcher's arguments", { timeout: 60_000 }, () => {
  const layout = serviceLayout("win32", { ProgramData: "C:\\ProgramData", ProgramFiles: "C:\\Program Files" });
  const line = serviceHostCommandLine({ host: layout.serviceHost, program: layout.executable, args: ["--stop-on-stdin-close", "--log-file", layout.logFile, "--app-cache", layout.appCache], layout });
  assert.equal(line, '"C:\\Program Files\\Kin\\kin-service-host.exe" --program "C:\\Program Files\\Kin\\kin.exe" --working-directory C:\\ProgramData\\Kin --env KIN_DATA_DIR=C:\\ProgramData\\Kin --stop-timeout 40 --log-file C:\\ProgramData\\Kin\\logs\\service-host.log -- --stop-on-stdin-close --log-file C:\\ProgramData\\Kin\\logs\\kin.log --app-cache C:\\ProgramData\\Kin-app');
  // A data folder with spaces, quotes and a trailing backslash survives.
  const odd = serviceLayout("win32", { KIN_DATA_DIR: 'D:\\Kin "home" data\\', ProgramData: "C:\\ProgramData", ProgramFiles: "C:\\Program Files" });
  const args = windowsArgv(serviceHostCommandLine({ host: odd.serviceHost, program: odd.executable, args: ["--log-file", odd.logFile], layout: odd }));
  assert.deepEqual(args.slice(0, 7), [odd.serviceHost, "--program", odd.executable, "--working-directory", odd.dataDirectory, "--env", `KIN_DATA_DIR=${odd.dataDirectory}`]);
  assert.deepEqual(args.slice(-3), ["--", "--log-file", odd.logFile]);
});

test("Windows with the service host: install registers a LOCAL SERVICE service that starts at boot and is restarted on failure", { timeout: 60_000 }, () => {
  const host = "C:\\Users\\m\\Downloads\\kin-service-host-1.6.0-win-x64.exe";
  const plan = servicePlan("install", { platform: "win32", program: DOWNLOADED, env: WINDOWS_ENV, exists: only(host) });
  assert.deepEqual(plan.steps.map(({ kind, command, args, path, to }) => [kind, command ? `${command} ${args[0]}` : path ?? to ?? null]), [
    ["admin", null],
    ["stop-service", null],
    ["run", "schtasks /End"],
    ["run", "schtasks /Delete"],
    ["mkdir", "C:\\ProgramData\\Kin"],
    ["run", "icacls C:\\ProgramData\\Kin"],
    ["mkdir", "C:\\ProgramData\\Kin-app"],
    ["run", "icacls C:\\ProgramData\\Kin-app"],
    ["mkdir", "C:\\Program Files\\Kin"],
    ["copy", "C:\\Program Files\\Kin\\kin.exe"],
    ["copy", "C:\\Program Files\\Kin\\kin-service-host.exe"],
    ["run", "icacls C:\\Program Files\\Kin"],
    ["run", "sc.exe create"],
    ["run", "sc.exe config"],
    ["run", "sc.exe description"],
    ["run", "sc.exe failure"],
    ["run", "sc.exe failureflag"],
    ["run", "sc.exe start"],
  ]);
  assert.deepEqual(plan.steps[1], { kind: "stop-service", name: "Kin", timeoutMs: 60_000 });
  assert.ok(plan.steps.slice(2, 4).every(({ allowFailure }) => allowFailure === true), "an old scheduled task may not exist");
  assert.equal(plan.steps.find(({ to }) => to?.endsWith("kin-service-host.exe")).from, host);
  const create = plan.steps.find(({ args }) => args?.[0] === "create");
  assert.deepEqual(create.unless, { command: "sc.exe", args: ["query", "Kin"] });
  const [, name, binPathKey, binPath, ...settings] = create.args;
  assert.equal(name, "Kin");
  assert.equal(binPathKey, "binPath=");
  assert.deepEqual(settings, ["start=", "auto", "obj=", "NT AUTHORITY\\LocalService", "password=", "", "DisplayName=", "Kin home server"]);
  assert.deepEqual(windowsArgv(binPath), [
    "C:\\Program Files\\Kin\\kin-service-host.exe",
    "--program", "C:\\Program Files\\Kin\\kin.exe",
    "--working-directory", "C:\\ProgramData\\Kin",
    "--env", "KIN_DATA_DIR=C:\\ProgramData\\Kin",
    "--stop-timeout", "40",
    "--log-file", "C:\\ProgramData\\Kin\\logs\\service-host.log",
    "--",
    "--stop-on-stdin-close", "--log-file", "C:\\ProgramData\\Kin\\logs\\kin.log", "--app-cache", "C:\\ProgramData\\Kin-app",
  ]);
  // A reinstall updates the existing service with the same settings.
  assert.deepEqual(plan.steps.find(({ args }) => args?.[0] === "config").args.slice(2), create.args.slice(2));
  const byFirst = (word) => plan.steps.find(({ args }) => args?.[0] === word).args;
  assert.deepEqual(byFirst("failure"), ["failure", "Kin", "reset=", "86400", "actions=", "restart/5000/restart/30000/restart/60000"]);
  assert.deepEqual(byFirst("failureflag"), ["failureflag", "Kin", "1"]);
  assert.ok(!plan.steps.some(({ kind }) => kind === "task"));
  assert.ok(plan.notes.some((note) => note.includes('Windows service "Kin"') && note.includes("LOCAL SERVICE") && note.includes("service-host.log")));

  // Reinstalling from the installed copy copies nothing onto itself.
  const again = servicePlan("install", { platform: "win32", program: INSTALLED, env: WINDOWS_ENV, exists: only("C:\\Program Files\\Kin\\kin-service-host.exe") });
  assert.ok(!again.steps.some(({ kind }) => kind === "copy"));
  assert.ok(again.steps.some(({ args }) => args?.[0] === "create"));

  // From a checkout, node and the built host run in place.
  const built = "C:\\src\\kin\\tools\\kin-service-host\\target\\release\\kin-service-host.exe";
  const checkout = servicePlan("install", { platform: "win32", program: { kind: "node", command: "C:\\node\\node.exe", args: ["C:\\src\\kin\\server\\start.mjs"] }, env: WINDOWS_ENV, exists: only(built) });
  assert.ok(!checkout.steps.some(({ kind }) => kind === "copy"));
  assert.deepEqual(windowsArgv(checkout.steps.find(({ args }) => args?.[0] === "create").args[3]).filter((arg, index, all) => index === 0 || all[index - 1] === "--program" || index > all.indexOf("--")), [
    built, "C:\\node\\node.exe", "C:\\src\\kin\\server\\start.mjs", "--stop-on-stdin-close", "--log-file", "C:\\ProgramData\\Kin\\logs\\kin.log",
  ]);
});

test("Windows: uninstall stops and deletes the service and any old task, and keeps the data", { timeout: 60_000 }, () => {
  for (const exists of [NOTHING, only("C:\\Program Files\\Kin\\kin-service-host.exe")]) {
    const plan = servicePlan("uninstall", { platform: "win32", program: INSTALLED, env: WINDOWS_ENV, exists });
    assert.deepEqual(plan.steps.map(({ kind, command, args }) => (command ? `${command} ${args.join(" ")}` : kind)), [
      "admin", "stop-service", "sc.exe delete Kin", "schtasks /End /TN Kin", "schtasks /Delete /TN Kin /F", "remove",
    ]);
    assert.ok(plan.steps.filter(({ kind }) => kind === "run").every(({ allowFailure }) => allowFailure === true));
    assert.equal(plan.steps.at(-1).path, "C:\\Program Files\\Kin");
    assertKeepsData(plan);
  }
});

test("print-service on Windows prints the sc.exe commands when the host is there", { timeout: 60_000 }, async () => {
  let output = "";
  const stdout = { write: (text) => { output += text; } };
  const fs = { existsSync: only("C:\\Users\\m\\Downloads\\kin-service-host.exe") };
  assert.equal(await runServiceCommand({ command: "print-service" }, { program: DOWNLOADED, env: WINDOWS_ENV, platform: "win32", stdout, fs }), 0);
  assert.ok(output.startsWith('# Windows service Kin\nsc.exe create Kin binPath= "\\"C:\\Program Files\\Kin\\kin-service-host.exe\\" --program \\"C:\\Program Files\\Kin\\kin.exe\\" '), output);
  assert.match(output, /start= auto obj= "NT AUTHORITY\\LocalService" password= "" DisplayName= "Kin home server"\n/);
  assert.match(output, /\nsc\.exe failure Kin reset= 86400 actions= restart\/5000\/restart\/30000\/restart\/60000\nsc\.exe failureflag Kin 1\n$/);
});

test("stopping a service waits until sc.exe reports it stopped, and gives up after the limit", { timeout: 60_000 }, () => {
  const STATES = { 1: "STOPPED", 3: "STOP_PENDING", 4: "RUNNING" };
  const query = (state) => ({ code: 0, stdout: `SERVICE_NAME: Kin\n        TYPE               : 10  WIN32_OWN_PROCESS\n        STATE              : ${state}  ${STATES[state]}\n`, stderr: "" });
  assert.equal(serviceState(query(4).stdout), 4);
  assert.equal(serviceState("nothing here"), null);

  const scripted = (states) => {
    const commands = [];
    const run = (command, args) => {
      commands.push(`${command} ${args.join(" ")}`);
      if (args[0] === "stop") return { code: 0, stdout: "", stderr: "" };
      const next = states.length > 1 ? states.shift() : states[0];
      return next === null ? { code: 1060, stdout: "", stderr: "The specified service does not exist as an installed service." } : query(next);
    };
    return { run, commands };
  };
  const step = { kind: "stop-service", name: "Kin", timeoutMs: 60_000 };
  let sleeps = 0;
  const running = scripted([4, 3, 3, 1]);
  executePlan({ steps: [step] }, { run: running.run, sleep: () => { sleeps += 1; } });
  assert.deepEqual(running.commands, ["sc.exe query Kin", "sc.exe stop Kin", "sc.exe query Kin", "sc.exe query Kin", "sc.exe query Kin"]);
  assert.equal(sleeps, 2);

  for (const states of [[null], [1]]) {
    const idle = scripted(states);
    executePlan({ steps: [step] }, { run: idle.run, sleep: () => assert.fail("nothing to wait for") });
    assert.deepEqual(idle.commands, ["sc.exe query Kin"], "not installed, or already stopped");
  }

  let clock = 0;
  const stuck = scripted([4]);
  assert.throws(
    () => executePlan({ steps: [{ ...step, timeoutMs: 2_000 }] }, { run: stuck.run, now: () => clock, sleep: (ms) => { clock += ms; } }),
    (error) => error instanceof ServiceInstallError && /didn't stop within 2 seconds/.test(error.message),
  );
});
