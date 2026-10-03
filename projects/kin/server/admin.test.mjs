import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireDatabaseMaintenanceLock, DurableStore } from "./durable-store.mjs";
import { createKinServer } from "./server.mjs";
import { resolveDurablePath, webRoot } from "./path-safety.mjs";

function admin(databasePath, ...args) {
  return spawnSync(
    process.execPath,
    [join(import.meta.dirname, "admin.mjs"), ...args],
    {
      env: { ...process.env, KIN_DATABASE_PATH: databasePath },
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    },
  );
}

function rejected(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /must be outside the static web root/);
}

function directoryLink(target, path) {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

test("admin permits verified backup and restore outside the web root", () => {
  const directory = mkdtempSync(join(tmpdir(), "kin-admin-"));
  const source = join(directory, "kin.sqlite");
  const backup = join(directory, "new", "nested", "backup.sqlite");
  const restored = join(directory, "restore", "kin.sqlite");
  const store = new DurableStore(source);
  try {
    const result = admin(source, "backup", backup);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(store.health(), true);
    const restore = admin(restored, "restore", backup);
    assert.ifError(restore.error);
    assert.equal(restore.status, 0, restore.stderr);
    const verification = new DurableStore(restored);
    try {
      assert.equal(verification.validate(), true);
    } finally {
      verification.close();
    }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("admin and service reject the web root and all descendants before creating files", () => {
  const directory = mkdtempSync(join(tmpdir(), "kin-admin-"));
  const source = join(directory, "kin.sqlite");
  const store = new DurableStore(source);
  try {
    for (const unsafe of [
      webRoot,
      join(webRoot, "backup.sqlite"),
      join(webRoot, "missing-admin-subdir", "backup.sqlite"),
    ]) {
      rejected(admin(source, "backup", unsafe));
      rejected(admin(source, "restore", unsafe));
      rejected(admin(unsafe, "restore", source));
      rejected(admin(unsafe, "backup", join(directory, "backup.sqlite")));
      assert.throws(
        () => createKinServer({ databasePath: unsafe }),
        /outside the static web root/,
      );
    }
    assert.equal(existsSync(join(webRoot, "missing-admin-subdir")), false);
    assert.equal(existsSync(join(directory, "backup.sqlite")), false);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("admin and service resolve symlinked ancestors even before nested directories exist", () => {
  const directory = mkdtempSync(join(tmpdir(), "kin-admin-links-"));
  const alias = join(directory, "public-alias");
  const source = join(directory, "kin.sqlite");
  const store = new DurableStore(source);
  try {
    directoryLink(webRoot, alias);
    for (const unsafe of [
      alias,
      join(alias, "index.html"),
      join(alias, "backup.sqlite"),
      join(alias, "missing-admin-parent", "child", "backup.sqlite"),
    ]) {
      rejected(admin(source, "backup", unsafe));
      rejected(admin(source, "restore", unsafe));
      rejected(admin(unsafe, "restore", source));
      assert.throws(
        () => createKinServer({ databasePath: unsafe }),
        /outside the static web root/,
      );
    }
    assert.equal(existsSync(join(webRoot, "missing-admin-parent")), false);
    const privateDirectory = join(directory, "private");
    mkdirSync(privateDirectory);
    const privateAlias = join(directory, "private-alias");
    directoryLink(privateDirectory, privateAlias);
    assert.equal(
      resolveDurablePath(join(privateAlias, "new", "kin.sqlite")),
      join(realpathSync(privateDirectory), "new", "kin.sqlite"),
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("static routes cannot serve durable state through traversal or symlink aliases", async () => {
  // A sibling whose name begins with 'web' catches unsafe string-prefix guards.
  const directory = mkdtempSync(join(webRoot, "..", "web-private-test-"));
  const linkDirectory = mkdtempSync(join(webRoot, "static-safety-test-"));
  const source = join(directory, "kin.sqlite");
  const backup = join(directory, "backup.sqlite");
  const app = createKinServer({ databasePath: source });
  let releaseMaintenanceLock;
  try {
    await app.store.backup(backup);
    releaseMaintenanceLock = acquireDatabaseMaintenanceLock(source, "backup");
    directoryLink(directory, join(linkDirectory, "private"));
    await new Promise((resolve, reject) => {
      app.server.once("error", reject);
      app.server.listen(0, "127.0.0.1", resolve);
    });
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    const name = directory.split(/[\\/]/).at(-1);
    const linkName = linkDirectory.split(/[\\/]/).at(-1);
    for (const file of [
      "kin.sqlite",
      "backup.sqlite",
      "kin.sqlite-wal",
      "kin.sqlite-shm",
      "kin.sqlite.service.lock",
      "kin.sqlite.maintenance.lock",
    ]) {
      assert.equal(existsSync(join(directory, file)), true, file);
      for (const path of [
        `/${file}`,
        `/%2e%2e%2f${name}/${file}`,
        `/%2e%2e%5c${name}/${file}`,
        `/${linkName}/private/${file}`,
      ]) {
        const response = await fetch(`${origin}${path}`);
        assert.equal(response.status, 404, path);
        assert.equal(await response.text(), "Not found");
      }
    }
    assert.equal((await fetch(`${origin}/`)).status, 200);
    assert.equal((await fetch(`${origin}/readiness`)).status, 200);
  } finally {
    if (app.server.listening)
      await new Promise((resolve) => app.server.close(resolve));
    releaseMaintenanceLock?.();
    app.store.close();
    rmSync(linkDirectory, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});
