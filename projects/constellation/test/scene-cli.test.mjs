import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseScene } from "../src/scene.mjs";

test("offline CLI scene inspection preserves output boundaries and fixed-date reproducibility", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "constellation-scene-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = JSON.parse(
    await readFile(new URL("./fixtures/scene-svg-v2.json", import.meta.url)),
  );
  const repos = join(dir, "repos.json"),
    output = join(dir, "scene.json"),
    actionOutput = join(dir, "action-output");
  await writeFile(repos, JSON.stringify(fixture.repositories));
  const env = {
    ...process.env,
    CONSTELLATION_CONFIG: "",
    CONSTELLATION_CONFIG_JSON: "",
    GITHUB_OUTPUT: actionOutput,
    CONSTELLATION_OUTPUT: join(dir, "unused.svg"),
  };
  const run = (args) =>
    spawnSync(
      process.execPath,
      [
        "src/cli.mjs",
        "--username",
        "fixture",
        "--fixture",
        repos,
        "--reference-date",
        "2026-09-01T00:00:00Z",
        ...args,
      ],
      { encoding: "utf8", env, windowsHide: true },
    );
  const summary = run(["--scene", "--explain"]);
  assert.equal(summary.status, 0, summary.stderr);
  const stats = JSON.parse(summary.stdout);
  assert.equal(stats.nodes, 4);
  assert.equal(stats.filters.loaded, 4);
  assert.equal(stats.pipeline.loaded, 4);
  assert.equal(stats.pipeline.graphNodes, 4);
  assert.equal(stats.evidence.version, 1);
  assert.ok(stats.evidence.facts.length > 0);
  assert.ok(stats.cache.entries > 0);
  const first = run(["--scene-json"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(parseScene(first.stdout).nodes.length, 4);
  assert.equal(run(["--scene-json"]).stdout, first.stdout);
  const file = run(["--scene-json", "--output", output]);
  assert.equal(file.status, 0, file.stderr);
  assert.equal(file.stdout, "");
  assert.equal(await readFile(output, "utf8"), first.stdout);
  const dryOutput = join(dir, "dry.json");
  assert.equal(
    run(["--scene-json", "--output", dryOutput, "--dry-run"]).stdout,
    first.stdout,
  );
  await assert.rejects(access(dryOutput));
  await assert.rejects(access(actionOutput));
  await assert.rejects(access(env.CONSTELLATION_OUTPUT));
  assert.equal(run(["--scene-json", "--explain"]).status, 1);
  assert.equal(run(["--scene", "--scene-json"]).status, 1);
});

test("CLI generates Developer Topology from v7 config through the Rust engine", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "constellation-profile-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = JSON.parse(
    await readFile(new URL("./fixtures/scene-svg-v2.json", import.meta.url)),
  );
  const repos = join(dir, "repos.json"),
    config = join(dir, "config.json"),
    output = join(dir, "profile.svg");
  await writeFile(repos, JSON.stringify(fixture.repositories));
  await writeFile(
    config,
    JSON.stringify({
      version: 7,
      account: "fixture",
      options: {
        arrangement: "profile",
        profileEmphasis: "systems",
        animate: false,
        projectShowcase: {
          "fixture/project-0": { role: "featured", priority: 1 },
        },
      },
    }),
  );
  const result = spawnSync(
    process.execPath,
    [
      "src/cli.mjs",
      "build",
      "--username",
      "fixture",
      "--fixture",
      repos,
      "--config",
      config,
      "--reference-date",
      "2026-09-01T00:00:00Z",
      "--output",
      output,
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        CONSTELLATION_CONFIG: "",
        CONSTELLATION_CONFIG_JSON: "",
        GITHUB_OUTPUT: "",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const svg = await readFile(output, "utf8");
  assert.match(svg, /developer-profile-description/);
  assert.match(svg, /Strongest evidence/);
  assert.match(svg, /fixture\/project-0/);
  assert.match(svg, /featured project role weight/);
});
