#!/usr/bin/env node
// Runs Kin's Windows service host (tools/kin-service-host, #749) as a real
// Windows service, for CI's Windows runner (which is an administrator):
//
//   node scripts/service-host-smoke.mjs PATH\TO\kin-service-host.exe
//
// It registers a throwaway service whose child is a small Node script, then
// checks that the Service Control Manager sees it start (no error 1053),
// that a child which fails is started again, that a stop closes the child's
// stdin and ends with exit code 0, and that a child which ignores the stop
// is ended after --stop-timeout with its exit code reported. The service and
// its folder are removed afterwards, whatever happened.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serviceState, windowsArgument } from "../server/service-install.mjs";

const CHILD = `"use strict";
// The service's child: counts its starts in its folder, fails the first
// time, then waits for its stdin to close (unless told to ignore it).
const fs = require("node:fs");
const path = require("node:path");
const folder = process.argv[2];
const count = fs.readdirSync(folder).filter((name) => name.startsWith("start-")).length + 1;
fs.writeFileSync(path.join(folder, "start-" + count), String(process.pid));
if (count === 1) process.exit(3);
if (process.env.KIN_SMOKE_IGNORE_STOP !== "1") {
  process.stdin.on("end", () => { fs.writeFileSync(path.join(folder, "stopped"), "stdin closed"); process.exit(0); });
  process.stdin.resume();
}
setInterval(() => {}, 1000);
`;

function sc(...args) {
  const result = spawnSync("sc.exe", args, { encoding: "utf8", timeout: 30_000, windowsHide: true });
  return { code: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function must(result, what) {
  if (result.code !== 0) throw new Error(`${what} failed (${result.code}): ${result.output.trim()}`);
  return result;
}

const pause = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

function waitFor(what, check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}.`);
    pause(250);
  }
}

const state = (name) => serviceState(sc("query", name).output);
const exitCodes = (name) => {
  const output = sc("query", name).output;
  return { win32: Number(/WIN32_EXIT_CODE\s*:\s*(\d+)/.exec(output)?.[1]), service: Number(/SERVICE_EXIT_CODE\s*:\s*(\d+)/.exec(output)?.[1]) };
};

function main() {
  if (process.platform !== "win32") throw new Error("This smoke test runs on Windows only.");
  const host = resolve(process.argv[2] ?? "");
  if (!process.argv[2] || !existsSync(host)) throw new Error("Usage: node scripts/service-host-smoke.mjs PATH\\TO\\kin-service-host.exe");
  const name = `KinHostSmoke${randomBytes(3).toString("hex")}`;
  const folder = mkdtempSync(join(tmpdir(), "kin-host-smoke-"));
  const log = join(folder, "host.log");
  writeFileSync(join(folder, "child.cjs"), CHILD);
  const binPath = (extra) => [host, "--program", process.execPath, "--working-directory", folder, ...extra, "--log-file", log, "--", join(folder, "child.cjs"), folder].map(windowsArgument).join(" ");
  const starts = () => readdirSync(folder).filter((entry) => entry.startsWith("start-")).length;
  try {
    must(sc("create", name, "binPath=", binPath(["--stop-timeout", "20"]), "start=", "demand"), "sc create");
    must(sc("start", name), "sc start");
    waitFor("RUNNING", () => state(name) === 4);
    waitFor("the failed child to be started again", () => starts() >= 2);
    console.log(`${name} is running; its child was restarted after failing.`);
    sc("stop", name);
    waitFor("STOPPED", () => state(name) === 1);
    if (!existsSync(join(folder, "stopped"))) throw new Error("The child's stdin wasn't closed before it stopped.");
    const clean = exitCodes(name);
    if (clean.win32 !== 0) throw new Error(`A clean stop reported ${JSON.stringify(clean)}.`);
    console.log("A stop closed the child's stdin and the service stopped with code 0.");

    // A child that ignores the stop is ended after --stop-timeout.
    must(sc("config", name, "binPath=", binPath(["--env", "KIN_SMOKE_IGNORE_STOP=1", "--stop-timeout", "2"])), "sc config");
    must(sc("start", name), "sc start");
    waitFor("RUNNING again", () => state(name) === 4 && starts() >= 3);
    const asked = Date.now();
    sc("stop", name);
    waitFor("STOPPED after the timeout", () => state(name) === 1);
    const ended = exitCodes(name);
    // ERROR_SERVICE_SPECIFIC_ERROR with TerminateProcess's exit code 1.
    if (ended.win32 !== 1066 || ended.service !== 1) throw new Error(`An ended child reported ${JSON.stringify(ended)}.`);
    console.log(`A child that ignored the stop was ended after ${Date.now() - asked} ms and its code reported.`);

    const lines = readFileSync(log, "utf8");
    for (const event of ["service_host_child_started", "service_host_child_exited", "service_host_stop_requested", "service_host_child_killed", "service_host_stopped"])
      if (!lines.includes(`"${event}"`)) throw new Error(`The host log has no ${event}:\n${lines}`);
    console.log("The service host works as a Windows service.");
  } finally {
    sc("stop", name);
    try {
      waitFor("the smoke service to stop", () => ![3, 4].includes(state(name)), 30_000);
    } catch (error) {
      console.error(error.message);
    }
    sc("delete", name);
    rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
