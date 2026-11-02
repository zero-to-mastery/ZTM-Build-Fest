import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const gitPath = spawnSync("git", ["--exec-path"], { encoding: "utf8" }).stdout.trim();
const bash = process.platform === "win32" ? path.resolve(gitPath, "..", "..", "..", "bin", "bash.exe") : "bash";
const script = fileURLToPath(new URL("../../scripts/container-git.sh", import.meta.url)).replaceAll("\\", "/");

test("container Git recovery restores exact source HEAD without replacing shipped files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ob-container-git-"));
  const source = path.join(root, "source");
  const image = path.join(root, "image");
  fs.mkdirSync(source);
  fs.mkdirSync(image);
  function git(args) {
    const result = spawnSync("git", args, { cwd: source, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  try {
    git(["init", "-q"]);
    git(["config", "user.name", "Container test"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(path.join(source, "post.md"), "Shipped draft");
    git(["add", "."]);
    git(["commit", "-qm", "Source"]);
    const commit = git(["rev-parse", "HEAD"]);
    fs.copyFileSync(path.join(source, "post.md"), path.join(image, "post.md"));
    const env = {
      ...process.env,
      RENDER_GIT_COMMIT: commit,
      RENDER_GIT_REPO_SLUG: "example/blog",
      RENDER_GIT_BRANCH: "main",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: `url.${source.replaceAll("\\", "/")}.insteadOf`,
      GIT_CONFIG_VALUE_0: "https://github.com/example/blog.git",
      GIT_CONFIG_KEY_1: "protocol.file.allow",
      GIT_CONFIG_VALUE_1: "always",
    };
    const recovered = spawnSync(bash, [script], { cwd: image, env, encoding: "utf8", timeout: 30_000 });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(spawnSync("git", ["rev-parse", "HEAD"], { cwd: image, encoding: "utf8" }).stdout.trim(), commit);
    assert.equal(fs.readFileSync(path.join(image, "post.md"), "utf8"), "Shipped draft");
    fs.writeFileSync(path.join(image, "post.md"), "Unpublished local edit");
    const restarted = spawnSync(bash, [script], { cwd: image, env, encoding: "utf8", timeout: 30_000 });
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.equal(fs.readFileSync(path.join(image, "post.md"), "utf8"), "Unpublished local edit");

    const mismatch = path.join(root, "mismatch");
    fs.mkdirSync(mismatch);
    fs.writeFileSync(path.join(mismatch, "post.md"), "Different source");
    const rejected = spawnSync(bash, [script], { cwd: mismatch, env, encoding: "utf8", timeout: 30_000 });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /differ from RENDER_GIT_COMMIT/);
    assert.equal(fs.readFileSync(path.join(mismatch, "post.md"), "utf8"), "Different source");

    const sshImage = path.join(root, "ssh-image");
    fs.mkdirSync(sshImage);
    fs.copyFileSync(path.join(source, "post.md"), path.join(sshImage, "post.md"));
    const sshEnv = {
      ...env,
      OPENBLOG_GIT_SSH_KEY_PATH: "/run/secrets/deploy-key",
      GIT_CONFIG_VALUE_0: "git@github.com:example/blog.git",
    };
    const sshRecovered = spawnSync(bash, [script], { cwd: sshImage, env: sshEnv, encoding: "utf8", timeout: 30_000 });
    assert.equal(sshRecovered.status, 0, sshRecovered.stderr);
    assert.equal(spawnSync("git", ["remote", "get-url", "origin"], { cwd: sshImage, encoding: "utf8" }).stdout.trim(), "git@github.com:example/blog.git");
    assert.equal(spawnSync("git", ["rev-parse", "HEAD"], { cwd: sshImage, encoding: "utf8" }).stdout.trim(), commit);
    assert.equal(fs.readFileSync(path.join(sshImage, "post.md"), "utf8"), "Shipped draft");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Docker compiler and runtime use bookworm and execute binary during image build", () => {
  const dockerfile = fs.readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /FROM rust:1-slim-bookworm AS build/);
  assert.match(dockerfile, /FROM debian:bookworm-slim/);
  assert.match(dockerfile, /RUN openblog help > \/dev\/null/);
});
