import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createReleaseEvidence,
  getAcceptanceMatrixPath,
  validateAcceptanceMatrix,
} from "./release-evidence-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const { version: release } = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const matrixPath = getAcceptanceMatrixPath(root, release);
const outputDirectory = resolve(root, "release-evidence");
const outputPath = resolve(outputDirectory, "release-evidence.json");
const matrix = validateAcceptanceMatrix(
  JSON.parse(await readFile(matrixPath, "utf8")),
  { expectedRelease: release },
);
const server = process.env.GITHUB_SERVER_URL;
const repository = process.env.GITHUB_REPOSITORY;
const runId = process.env.GITHUB_RUN_ID || null;
const report = createReleaseEvidence(matrix, {
  sha: process.env.GITHUB_SHA,
  ref: process.env.GITHUB_REF,
  runId,
  runUrl:
    server && repository && runId
      ? `${server}/${repository}/actions/runs/${runId}`
      : null,
  jobs: Object.fromEntries(
    ["verify", "browser", "chrome", "rust"]
      .map((job) => [job, process.env[`RELEASE_${job.toUpperCase()}_RESULT`]])
      .filter(([, result]) => result),
  ),
  fullBrowserMatrix: process.env.RELEASE_FULL_BROWSER_MATRIX === "true",
});
await mkdir(outputDirectory, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`Release evidence written to ${outputPath}`);
console.log(
  `${report.summary.automatedPassed} automated gates passed, ${report.summary.automatedFailed} failed, ${report.summary.automatedPending} pending; ${report.summary.manualPending} manual gates pending.`,
);
