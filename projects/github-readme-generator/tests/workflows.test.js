import { it, expect } from "vitest";
import { generateWorkflow } from "../src/workflows/model.js";
import { yaml } from "../src/workflows/serialize.js";
import {
  workflowPath,
  validCron,
  workflowHealth,
} from "../src/workflows/validate.js";
it("serializes safe YAML scalars without mapping injection", () => {
  expect(
    yaml({ name: "a\npermissions: write-all", on: { workflow_dispatch: {} } }),
  ).toBe(
    '"name": "a\\npermissions: write-all"\n"on":\n  "workflow_dispatch": {}',
  );
});
it("generates attributed Constellation with explicit permissions and optional config", () => {
  const r = generateWorkflow({
    provider: "constellation",
    username: "octocat",
    repository: "octocat/octocat",
    publish: true,
    output: "assets/sky.svg",
    configJson: '{"version":7}',
    schedule: "daily",
  });
  expect(r.model.permissions.contents).toBe("write");
  expect(r.model.on.schedule[0].cron).toBe("17 3 * * *");
  expect(r.yaml).toContain("mnichols08/constellation@v3.0.0");
  expect(r.embed).toContain("/output/sky.svg");
  expect(r.embed).toContain("Made with");
  expect(r.yaml).toContain("${{ secrets.GITHUB_TOKEN }}");
  expect(
    generateWorkflow({ provider: "constellation" }).model.permissions.contents,
  ).toBe("read");
});
it("Snake preserves other output files and generates a theme-aware embed", () => {
  const r = generateWorkflow({
    provider: "snake",
    repository: "o/r",
    publish: true,
  });
  expect(r.yaml).toContain("Platane/snk/svg-only@v3");
  expect(r.yaml).toContain('"keep_files": true');
  expect(r.embed).toContain("<picture>");
  expect(r.embed).toContain("snake-dark.svg");
});
it("Metrics uses only named secrets and documents its external configuration", () => {
  const r = generateWorkflow({
    provider: "metrics",
    secretName: "MY_METRICS_TOKEN",
    publish: true,
  });
  expect(r.yaml).toContain("${{ secrets.MY_METRICS_TOKEN }}");
  expect(r.yaml).toContain("lowlighter/metrics@v3.34");
  expect(r.model.permissions.contents).toBe("write");
  expect(generateWorkflow({ provider: "metrics" }).yaml).toContain(
    '"output_action": "none"',
  );
  expect(() =>
    generateWorkflow({
      provider: "metrics",
      secretName: "ghp_actual-secret-value",
    }),
  ).toThrow("NAME");
});
it("generic commands and asset refresh remain explicit scaffolds", () => {
  expect(
    generateWorkflow({
      provider: "generic",
      command: "node scripts/report.mjs",
    }).yaml,
  ).toContain("node scripts/report.mjs");
  expect(
    generateWorkflow({ provider: "generic", action: "owner/action@v1" }).yaml,
  ).toContain("owner/action@v1");
  expect(
    generateWorkflow({ provider: "asset-refresh" }).warnings.join(" "),
  ).toContain("repository script");
});
it.each([
  "../bad.yml",
  ".github/workflows/../bad.yml",
  ".github/workflows/.env",
  ".github/workflows/a.yml/extra",
])("rejects workflow path %s", (path) =>
  expect(() => workflowPath(path)).toThrow(),
);
it.each([
  "60 * * * *",
  "* 24 * * *",
  "* * 0 * *",
  "* * * 13 *",
  "* * * * 7",
  "*/0 * * * *",
  "0 0 * *",
  "1-0 * * * *",
])("rejects invalid cron %s", (cron) => expect(validCron(cron)).toBe(false));
it("accepts bounded cron fields and detects basic health issues", () => {
  expect(validCron("*/15 1-5 * 1,2 0")).toBe(true);
  const issues = workflowHealth(
    {
      name: "Duplicate",
      on: { schedule: [{ cron: "bad" }] },
      outputs: ["../unsafe"],
      jobs: {
        a: {
          steps: [{ uses: "owner/action@", with: { token: "literal-secret" } }],
        },
      },
    },
    { existingNames: ["Duplicate"] },
  );
  expect(issues).toHaveLength(6);
});
it("rejects expression, token, path and JSON injections before generating YAML", () => {
  for (const raw of [
    { username: "${{ secrets.X }}" },
    { provider: "generic", command: "TOKEN=secret-value" },
    { provider: "constellation", configJson: '{"token":"secret"}' },
    { output: "../bad.svg" },
    { filename: "../bad.yml" },
    { provider: "unknown" },
    { provider: "generic", action: "owner/action@" },
  ])
    expect(() => generateWorkflow(raw)).toThrow();
});
