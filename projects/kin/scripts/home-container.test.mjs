// The home server's container image (deploy/home/Dockerfile, #715). The CI
// job home-container builds and runs it; this checks what the image promises
// without Docker: a pinned, minimal base, an unprivileged user, /data as a
// volume, a health check, home mode, and the same node release as CI.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = async (path) => (await readFile(new URL(path, import.meta.url), "utf8")).replace(/\r\n/g, "\n");

test("the image runs the executable as an unprivileged user with /data as its volume", { timeout: 60_000 }, async () => {
  const dockerfile = await read("../deploy/home/Dockerfile");
  const stages = [...dockerfile.matchAll(/^FROM (\S+)/gm)].map((match) => match[1]);
  assert.deepEqual(stages, ["rust:1.93.0-slim", "node:24.22.0-slim", "gcr.io/distroless/cc-debian12:nonroot"]);
  const final = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
  assert.match(final, /^USER 65532:65532$/m);
  assert.ok(!/^USER (root|0)\b/m.test(final));
  assert.match(final, /^VOLUME \["\/data"\]$/m);
  assert.match(final, /COPY --from=build --chown=65532:65532 \/image\/data \/data/);
  assert.match(final, /KIN_MODE=home/);
  assert.match(final, /KIN_DATA_DIR=\/data/);
  assert.match(final, /KIN_HOST=127\.0\.0\.1/);
  assert.match(final, /^HEALTHCHECK [^\n]*\\\n\s+CMD \["\/opt\/kin\/kin", "--health"\]$/m);
  assert.match(final, /^ENTRYPOINT \["\/opt\/kin\/kin"\]$/m);
  assert.match(dockerfile, /node scripts\/build-sea\.mjs --target "\$target" --node-binary "\$\(command -v node\)"/);
  assert.match(dockerfile, /KIN_APP_CACHE=\/opt\/kin\/app \/opt\/kin\/kin --prepare/);
});

test("the image builds on the node release and Rust toolchain the project pins", { timeout: 60_000 }, async () => {
  const dockerfile = await read("../deploy/home/Dockerfile");
  const workflow = await read("../docs/ci/kin-verification.workflow.yml");
  const toolchain = await read("../rust-toolchain.toml");
  const node = /FROM node:(\d+\.\d+\.\d+)-slim/.exec(dockerfile)[1];
  for (const [, version] of workflow.matchAll(/node-version: (\S+)/g)) assert.equal(version, node);
  assert.equal(/FROM rust:(\S+)-slim/.exec(dockerfile)[1], /^channel\s*=\s*"([^"]+)"/m.exec(toolchain)[1]);
});

test("the build context keeps the executable's build script and leaves out tests", { timeout: 60_000 }, async () => {
  const ignore = (await read("../deploy/home/Dockerfile.dockerignore")).split(/\r?\n/).filter((line) => line && !line.startsWith("#"));
  for (const line of ["scripts", "!scripts/build-sea.mjs", "!scripts/sea", "**/*.test.mjs", ".git", ".kin-data", "web/wasm/kin_engine.wasm"])
    assert.ok(ignore.includes(line), line);
  // The last matching line wins: tests stay out even inside scripts/sea.
  assert.ok(ignore.indexOf("**/*.test.mjs") > ignore.indexOf("!scripts/sea"));
});
