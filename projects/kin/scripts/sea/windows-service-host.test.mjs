// The Windows service host in the Windows build (#749): it is built with
// cargo for the right Rust target (or taken prebuilt), checked to be a
// Windows x64 program, and written beside the executable.
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import {
  buildWindowsServiceHost, checkWindowsX64Program, SERVICE_HOST_MANIFEST, serviceHostFileName, serviceHostRustTarget,
} from "./windows-service-host.mjs";

/** The smallest headers checkWindowsX64Program reads. */
function peHeaders({ machine = 0x8664, magic = 0x20b, subsystem = 3 } = {}) {
  const bytes = Buffer.alloc(0x200);
  bytes.write("MZ", 0, "latin1");
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80, "latin1");
  bytes.writeUInt16LE(machine, 0x84);
  bytes.writeUInt16LE(magic, 0x98);
  bytes.writeUInt16LE(subsystem, 0x98 + 68);
  return bytes;
}

test("only a Windows x64 console program passes the check", { timeout: 30_000 }, () => {
  checkWindowsX64Program(peHeaders());
  for (const [bytes, why] of [
    [Buffer.from("\x7fELF and more bytes than sixty-four ............................................", "latin1"), /no MZ header/],
    [peHeaders({ machine: 0x14c }), /machine 0x14c/],
    [peHeaders({ machine: 0xaa64 }), /machine 0xaa64/],
    [peHeaders({ magic: 0x10b }), /not PE32\+/],
    [peHeaders({ subsystem: 2 }), /console-subsystem/],
    [peHeaders().subarray(0, 0x90), /no PE header/],
  ])
    assert.throws(() => checkWindowsX64Program(bytes), why);
});

test("the host is built for the msvc target on Windows and the gnu target elsewhere", { timeout: 30_000 }, () => {
  assert.equal(serviceHostRustTarget("win32"), "x86_64-pc-windows-msvc");
  assert.equal(serviceHostRustTarget("linux"), "x86_64-pc-windows-gnu");
  const commands = [];
  const written = new Map();
  const info = buildWindowsServiceHost({
    out: "out",
    version: "1.6.0",
    prebuilt: null,
    platform: "win32",
    run: (command, args) => { commands.push([command, ...args]); return { code: 0, output: "" }; },
    read: (path) => { assert.equal(path, join(SERVICE_HOST_MANIFEST, "..", "target", "x86_64-pc-windows-msvc", "release", "kin-service-host.exe")); return peHeaders(); },
    write: (path, bytes) => written.set(path, bytes),
  });
  assert.deepEqual(commands, [["cargo", "build", "--release", "--locked", "--manifest-path", SERVICE_HOST_MANIFEST, "--target", "x86_64-pc-windows-msvc"]]);
  assert.equal(info.file, serviceHostFileName("1.6.0"));
  assert.equal(info.file, "kin-service-host-1.6.0-win-x64.exe");
  assert.equal(info.rustTarget, "x86_64-pc-windows-msvc");
  assert.equal(info.size, 0x200);
  assert.match(info.sha256, /^[0-9a-f]{64}$/);
  assert.ok(written.has(join("out", "kin-service-host-1.6.0-win-x64.exe")));
});

test("a prebuilt host is used as given, and a failed build says what it needs", { timeout: 30_000 }, () => {
  const info = buildWindowsServiceHost({
    out: "out", version: "1.6.0", prebuilt: "C:\\ci\\kin-service-host.exe", platform: "linux",
    run: () => assert.fail("nothing is built"), read: () => peHeaders(), write: () => {},
  });
  assert.equal(info.prebuilt, true);
  assert.throws(
    () => buildWindowsServiceHost({ out: "out", version: "1.6.0", prebuilt: "C:\\ci\\host.exe", read: () => peHeaders({ machine: 0x14c }), write: () => assert.fail("not written") }),
    /isn't a Windows x64 program/,
  );
  assert.throws(
    () => buildWindowsServiceHost({ out: "out", version: "1.6.0", prebuilt: null, platform: "linux", run: () => ({ code: 101, output: "error[E0463]: can't find crate for `std`" }), write: () => {} }),
    (error) => error.name === "ServiceHostBuildError" && /x86_64-pc-windows-gnu Rust target and the mingw-w64 linker/.test(error.message) && /E0463/.test(error.message),
  );
});
