// Test health over recent CI runs (#332): for each job of the last N "Kin
// verification" runs on a branch, whether it passed cleanly, passed only
// after a retry (FLAKY, from the warning annotation scripts/verify.mjs writes,
// #328), or failed. Run on demand:
//
//   node scripts/test-health.mjs [--runs 20] [--branch kin-development] [--repo OWNER/NAME]
//
// Needs a GitHub token (GITHUB_TOKEN, GH_TOKEN or `gh auth token`). Reads only;
// prints a table, worst first, and the runs each flake or failure came from.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO = "mnichols08/ZTM-Build-Fest";
const WORKFLOW = "kin-verification.yml";
const FLAKY_TITLE = "Flaky browser suite: ";

/** Tallies jobs: runs is [{ id, url, jobs: [{ name, conclusion, flaky: [suite] }] }].
 * Returns rows { job, runs, clean, flaky, failed, flakyRate, examples } sorted
 * by trouble (failures, then flakes), then name. */
export function tally(runs) {
  const rows = new Map();
  for (const run of runs) {
    for (const job of run.jobs) {
      if (!["success", "failure"].includes(job.conclusion)) continue; // cancelled or skipped: no evidence
      const row = rows.get(job.name) ?? { job: job.name, runs: 0, clean: 0, flaky: 0, failed: 0, examples: [] };
      row.runs += 1;
      if (job.conclusion === "failure") { row.failed += 1; row.examples.push({ run: run.url, outcome: "failed" }); }
      else if (job.flaky.length) { row.flaky += 1; row.examples.push({ run: run.url, outcome: `flaky: ${job.flaky.join(", ")}` }); }
      else row.clean += 1;
      rows.set(job.name, row);
    }
  }
  return [...rows.values()]
    .map((row) => ({ ...row, flakyRate: row.runs ? row.flaky / row.runs : 0 }))
    .sort((a, b) => b.failed - a.failed || b.flaky - a.flaky || a.job.localeCompare(b.job));
}

/** The flaky suites a job's annotations name. */
export function flakySuites(annotations) {
  return annotations
    .filter((annotation) => annotation.annotation_level === "warning" && annotation.title?.startsWith(FLAKY_TITLE))
    .map((annotation) => annotation.title.slice(FLAKY_TITLE.length));
}

export function formatReport(rows, { branch, runCount }) {
  const percent = (value) => `${Math.round(value * 100)}%`;
  const lines = [`Kin verification on ${branch}: last ${runCount} completed runs`, ""];
  if (!rows.length) return [...lines, "No completed jobs found."].join("\n");
  const width = Math.max(...rows.map((row) => row.job.length), 3);
  lines.push(`${"Job".padEnd(width)}  runs  clean  flaky  failed  flaky rate`);
  for (const row of rows) lines.push(`${row.job.padEnd(width)}  ${String(row.runs).padStart(4)}  ${String(row.clean).padStart(5)}  ${String(row.flaky).padStart(5)}  ${String(row.failed).padStart(6)}  ${percent(row.flakyRate).padStart(10)}`);
  const troubled = rows.filter((row) => row.examples.length);
  if (troubled.length) {
    lines.push("", "Where:");
    for (const row of troubled) for (const { run, outcome } of row.examples) lines.push(`  ${row.job} — ${outcome} — ${run}`);
  }
  const clean = rows.every((row) => !row.flaky && !row.failed);
  lines.push("", clean ? "Every job passed first time in every run." : "Triage: docs/TESTING.md, \"Flaky browser suites\".");
  return lines.join("\n");
}

function token(env) {
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  if (env.GH_TOKEN) return env.GH_TOKEN;
  try { return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { return null; }
}

export async function collect({ repo = DEFAULT_REPO, branch = "kin-development", runCount = 20, github }) {
  const { workflow_runs: listed } = await github(`/repos/${repo}/actions/workflows/${WORKFLOW}/runs?branch=${encodeURIComponent(branch)}&status=completed&per_page=${runCount}`);
  const runs = [];
  for (const run of listed.slice(0, runCount)) {
    const { jobs } = await github(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`);
    const withFlakes = [];
    for (const job of jobs) {
      // A job's id is its check run's id; annotations carry the FLAKY warnings.
      const annotations = job.conclusion === "success" ? await github(`/repos/${repo}/check-runs/${job.id}/annotations?per_page=100`) : [];
      withFlakes.push({ name: job.name, conclusion: job.conclusion, flaky: flakySuites(annotations) });
    }
    runs.push({ id: run.id, url: run.html_url, jobs: withFlakes });
  }
  return runs;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
  const repo = option("--repo", DEFAULT_REPO), branch = option("--branch", "kin-development"), runCount = Number(option("--runs", "20"));
  const auth = token(process.env);
  if (!auth || !Number.isInteger(runCount) || runCount < 1 || runCount > 100) {
    console.error(!auth ? "Reading CI history needs a GitHub token: set GITHUB_TOKEN, or sign in with `gh auth login`." : "--runs must be 1 to 100.");
    process.exitCode = 1;
  } else {
    const github = async (path) => {
      const response = await fetch(`https://api.github.com${path}`, { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${auth}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "kin-test-health" } });
      if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path.split("?")[0]}`);
      return response.json();
    };
    collect({ repo, branch, runCount, github })
      .then((runs) => console.log(formatReport(tally(runs), { branch, runCount: runs.length })))
      .catch((error) => { console.error(error.message); process.exitCode = 1; });
  }
}
