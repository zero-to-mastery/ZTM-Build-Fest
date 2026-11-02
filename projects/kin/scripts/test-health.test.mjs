import assert from "node:assert/strict";
import test from "node:test";
import { collect, flakySuites, formatReport, tally } from "./test-health.mjs";

const job = (name, conclusion, flaky = []) => ({ name, conclusion, flaky });

test("jobs are tallied clean, flaky or failed, worst first, ignoring cancelled ones", () => {
  const rows = tally([
    { url: "r1", jobs: [job("browser (edge, passkey-regression)", "success", ["passkey regression"]), job("verify", "success"), job("browser (chrome, x)", "cancelled")] },
    { url: "r2", jobs: [job("browser (edge, passkey-regression)", "success"), job("verify", "failure")] },
    { url: "r3", jobs: [job("browser (edge, passkey-regression)", "success", ["passkey regression"]), job("verify", "success")] },
  ]);
  assert.deepEqual(rows.map(({ job: name, runs, clean, flaky, failed }) => [name, runs, clean, flaky, failed]), [
    ["verify", 3, 2, 0, 1],
    ["browser (edge, passkey-regression)", 3, 1, 2, 0],
  ]);
  assert.equal(rows[1].flakyRate, 2 / 3);
  assert.deepEqual(rows[1].examples, [{ run: "r1", outcome: "flaky: passkey regression" }, { run: "r3", outcome: "flaky: passkey regression" }]);
});

test("only verify.mjs's flaky warnings count as flakes", () => {
  assert.deepEqual(flakySuites([
    { annotation_level: "warning", title: "Flaky browser suite: security UI regression" },
    { annotation_level: "warning", title: "Something else" },
    { annotation_level: "failure", title: "Flaky browser suite: not a warning" },
  ]), ["security UI regression"]);
});

test("the report reads as a table with where each problem happened", () => {
  const text = formatReport(tally([{ url: "https://example/run/1", jobs: [job("verify", "failure"), job("browser (edge, a)", "success", ["a"])] }]), { branch: "kin-development", runCount: 1 });
  assert.match(text, /^Kin verification on kin-development: last 1 completed runs/);
  assert.match(text, /verify\s+1\s+0\s+0\s+1\s+0%/);
  assert.match(text, /browser \(edge, a\)\s+1\s+0\s+1\s+0\s+100%/);
  assert.match(text, /verify — failed — https:\/\/example\/run\/1/);
  assert.match(text, /Triage: docs\/TESTING\.md/);
  assert.match(formatReport(tally([{ url: "u", jobs: [job("verify", "success")] }]), { branch: "b", runCount: 1 }), /Every job passed first time/);
});

test("collect reads runs, jobs and only successful jobs' annotations", async () => {
  const asked = [];
  const github = async (path) => {
    asked.push(path.split("?")[0]);
    if (path.includes("/workflows/")) return { workflow_runs: [{ id: 7, html_url: "https://example/run/7" }] };
    if (path.endsWith("/jobs?per_page=100")) return { jobs: [{ id: 70, name: "verify", conclusion: "success" }, { id: 71, name: "browser (edge, x)", conclusion: "failure" }] };
    if (path.includes("/check-runs/70/")) return [{ annotation_level: "warning", title: "Flaky browser suite: x" }];
    throw new Error(`unexpected ${path}`);
  };
  const runs = await collect({ repo: "o/r", branch: "kin-development", runCount: 20, github });
  assert.deepEqual(runs, [{ id: 7, url: "https://example/run/7", jobs: [job("verify", "success", ["x"]), job("browser (edge, x)", "failure", [])] }]);
  assert.deepEqual(asked, ["/repos/o/r/actions/workflows/kin-verification.yml/runs", "/repos/o/r/actions/runs/7/jobs", "/repos/o/r/check-runs/70/annotations"]);
});
