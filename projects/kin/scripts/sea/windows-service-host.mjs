// The Windows service host (tools/kin-service-host, ADR 0025 §10, #749) for
// the Windows build of Kin's executable. scripts/build-sea.mjs calls
// buildWindowsServiceHost when it builds win-x64, and the host ships beside
// the executable as kin-service-host-<version>-win-x64.exe, which
// `kin --install-service` finds there (server/service-install.mjs).
//
// The host is built with cargo for x86_64-pc-windows-msvc on Windows, or
// x86_64-pc-windows-gnu elsewhere (that needs `rustup target add
// x86_64-pc-windows-gnu` and the mingw-w64 linker). A host built elsewhere,
// such as CI's Windows job, can be given instead with KIN_SERVICE_HOST_EXE.
// Either way the result is checked to be a Windows x64 program.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SERVICE_HOST_MANIFEST = join(PROJECT_ROOT, "tools", "kin-service-host", "Cargo.toml");

export class ServiceHostBuildError extends Error {
  constructor(message) {
    super(message);
    this.name = "ServiceHostBuildError";
  }
}

/** The Rust target the host is built for on this machine. */
export function serviceHostRustTarget(platform = process.platform) {
  return platform === "win32" ? "x86_64-pc-windows-msvc" : "x86_64-pc-windows-gnu";
}

export const serviceHostFileName = (version) => `kin-service-host-${version}-win-x64.exe`;

const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
const IMAGE_SUBSYSTEM_WINDOWS_CUI = 3;

/** Throws unless `bytes` is a Windows x64 console program (PE32+, AMD64). */
export function checkWindowsX64Program(bytes) {
  const fail = (why) => { throw new ServiceHostBuildError(`The service host isn't a Windows x64 program: ${why}.`); };
  if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) fail("no MZ header");
  const pe = bytes.readUInt32LE(0x3c);
  // Signature (4), COFF header (20), then the optional header's magic.
  if (pe + 24 + 70 > bytes.length || bytes.readUInt32LE(pe) !== 0x00004550) fail("no PE header");
  if (bytes.readUInt16LE(pe + 4) !== IMAGE_FILE_MACHINE_AMD64) fail(`machine 0x${bytes.readUInt16LE(pe + 4).toString(16)}`);
  if (bytes.readUInt16LE(pe + 24) !== 0x20b) fail("not PE32+");
  if (bytes.readUInt16LE(pe + 24 + 68) !== IMAGE_SUBSYSTEM_WINDOWS_CUI) fail("not a console-subsystem program");
}

function defaultRun(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { code: result.error ? -1 : result.status, output: `${result.stdout ?? ""}${result.stderr ?? result.error?.message ?? ""}` };
}

/**
 * Builds (or takes `prebuilt`) the host, writes it to `out` and returns
 * { file, size, sha256, rustTarget | prebuilt }.
 */
export function buildWindowsServiceHost({ out, version, prebuilt = process.env.KIN_SERVICE_HOST_EXE || null, platform = process.platform, run = defaultRun, read = readFileSync, write = writeFileSync, log = () => {} }) {
  let bytes;
  let origin;
  if (prebuilt) {
    log(`Using the service host ${prebuilt}`);
    bytes = read(prebuilt);
    origin = { prebuilt: true };
  } else {
    const rustTarget = serviceHostRustTarget(platform);
    log(`Building the Windows service host for ${rustTarget}`);
    const result = run("cargo", ["build", "--release", "--locked", "--manifest-path", SERVICE_HOST_MANIFEST, "--target", rustTarget]);
    if (result.code !== 0)
      throw new ServiceHostBuildError(`Building the Windows service host failed. It needs the ${rustTarget} Rust target${platform === "win32" ? "" : " and the mingw-w64 linker"}, or a host built elsewhere in KIN_SERVICE_HOST_EXE.\n${result.output.trim().split("\n").slice(-20).join("\n")}`);
    bytes = read(join(dirname(SERVICE_HOST_MANIFEST), "target", rustTarget, "release", "kin-service-host.exe"));
    origin = { rustTarget };
  }
  checkWindowsX64Program(bytes);
  const file = serviceHostFileName(version);
  write(join(out, file), bytes);
  return { file, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), ...origin };
}
