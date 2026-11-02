import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const entrypoint = fileURLToPath(new URL("../../docker-entrypoint.sh", import.meta.url));
const gitExecPath = process.platform === "win32"
  ? spawnSync("git", ["--exec-path"], { encoding: "utf8" }).stdout.trim()
  : "";
const bash = process.platform === "win32"
  ? path.resolve(gitExecPath, "..", "..", "..", "bin", "bash.exe")
  : "bash";

function run(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openblog-entrypoint-"));
  const log = path.join(dir, "calls");
  try {
    fs.writeFileSync(path.join(dir, "openblog"), `#!/bin/sh
printf 'openblog %s\\n' "$*" >> "$TEST_LOG"
case "$*" in
  "user list")
    [ "$TEST_LIST_FAIL" != 1 ] || { echo "invalid users file" >&2; exit 1; }
    printf '%s\\n' "$TEST_USERS" ;;
  "user passwd "*|"user add "*)
    [ "$TEST_BOOTSTRAP_FAIL" != 1 ] || { echo "cannot save users" >&2; exit 1; } ;;
esac
`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, "git"), `#!/bin/sh
printf 'git %s\\n' "$*" >> "$TEST_LOG"
case "$*" in
  "-C /blog remote get-url origin") printf '%s\\n' "$TEST_REMOTE" ;;
esac
`, { mode: 0o755 });
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("OPENBLOG_") || key.startsWith("GIT_AUTHOR_")) delete env[key];
    }
    Object.assign(env, {
      PATH: `${dir}${path.delimiter}${process.env.PATH}`,
      HOME: dir,
      TEST_LOG: log,
      TEST_BIN: dir.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`),
      TEST_ENTRYPOINT: entrypoint.replaceAll("\\", "/"),
      TEST_REMOTE: "https://github.com/example/blog.git",
      OPENBLOG_ADMIN_USER: "demo",
      OPENBLOG_ADMIN_PASSWORD: "example-password-for-tests",
      ...extra,
    });
    const result = spawnSync(bash, ["-c", 'export PATH="$TEST_BIN:$PATH"; exec /bin/sh "$TEST_ENTRYPOINT"'], {
      env, encoding: "utf8", timeout: 15_000,
    });
    assert.ifError(result.error);
    return { ...result, log: fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "" };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("container creates missing login and updates existing login before serving", () => {
  for (const [users, action] of [["", "add"], ["demo", "passwd"]]) {
    const result = run({ TEST_USERS: users });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.log, new RegExp(`openblog user ${action} demo`));
    assert.match(result.log, /openblog serve --admin --host 0\.0\.0\.0 --port 8080/);
  }
});

test("container fails visibly for incomplete credentials and failed user setup", () => {
  for (const env of [
    { OPENBLOG_ADMIN_PASSWORD: "" },
    { TEST_LIST_FAIL: "1" },
    { TEST_BOOTSTRAP_FAIL: "1" },
    { TEST_USERS: "demo", TEST_BOOTSTRAP_FAIL: "1" },
  ]) {
    const result = run(env);
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.trim());
    assert.doesNotMatch(result.log, /openblog serve/);
    assert.doesNotMatch(result.stderr, /example-password-for-tests/);
  }
});

test("Git credential helper references environment rather than persisting the token", () => {
  for (const remote of ["https://github.com/example/blog.git", "git@github.com:example/blog.git", "https://old-user:old-password@github.com/example/blog.git"]) {
    const result = run({ TEST_REMOTE: remote, OPENBLOG_GIT_TOKEN: "example-test-token" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.log, /remote set-url origin https:\/\/github\.com\/example\/blog\.git/);
    assert.match(result.log, /\$OPENBLOG_GIT_TOKEN/);
    assert.doesNotMatch(result.log + result.stdout + result.stderr, /example-test-token|old-password/);
  }
});

test("Git token refuses an unexpected remote host", () => {
  const result = run({ TEST_REMOTE: "https://other.example/repo.git", OPENBLOG_GIT_TOKEN: "example-test-token" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /github.com origin/);
  assert.doesNotMatch(result.log, /openblog serve/);
});

test("SSH publishing requires readable pinned credentials and cannot share token mode", () => {
  for (const extra of [
    { OPENBLOG_GIT_SSH_KEY_PATH: "/missing/deploy-key" },
    { OPENBLOG_GIT_SSH_KEY_PATH: "/missing/deploy-key", OPENBLOG_GIT_TOKEN: "example-test-token" },
  ]) {
    const result = run(extra);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /readable deploy-key|Configure only one/);
    assert.doesNotMatch(result.log, /openblog serve/);
    assert.doesNotMatch(result.stderr, /example-test-token/);
  }
});
