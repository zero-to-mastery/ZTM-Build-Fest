// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createReleaseEvidence,
  getAcceptanceMatrixPath,
  validateAcceptanceMatrix,
} from "../scripts/release-evidence-lib.mjs";

const matrix = {
  schemaVersion: 1,
  release: "1.9.24",
  gates: [
    {
      id: "build",
      kind: "automated",
      status: "required",
      evidence: "npm run build",
      jobs: ["verify"],
      requiresFullBrowserMatrix: true,
    },
    {
      id: "screen-reader",
      kind: "manual",
      status: "pending",
      instructions: "Run the documented screen-reader matrix.",
      evidence: null,
    },
  ],
};

describe("release evidence", () => {
  it("selects the acceptance matrix for the requested release", () => {
    expect(getAcceptanceMatrixPath("/workspace", "1.9.28")).toMatch(
      /docs[\\/]releases[\\/]1\.9\.28-acceptance\.json$/,
    );
    expect(getAcceptanceMatrixPath("/workspace", "1.9.29")).toMatch(
      /docs[\\/]releases[\\/]1\.9\.29-acceptance\.json$/,
    );
  });

  it("validates distinct gates and requires honest manual evidence", () => {
    expect(validateAcceptanceMatrix(matrix)).toEqual(matrix);
    expect(() =>
      validateAcceptanceMatrix({
        ...matrix,
        gates: [matrix.gates[0], { ...matrix.gates[0] }],
      }),
    ).toThrow(/duplicate/i);
    expect(() =>
      validateAcceptanceMatrix({
        ...matrix,
        gates: [
          matrix.gates[0],
          { ...matrix.gates[1], status: "passed", evidence: null },
        ],
      }),
    ).toThrow(/manual evidence/i);
    expect(() =>
      validateAcceptanceMatrix({
        ...matrix,
        gates: [
          { ...matrix.gates[0], requiresFullBrowserMatrix: "yes" },
          matrix.gates[1],
        ],
      }),
    ).toThrow(/full-browser-matrix/i);
    expect(() =>
      validateAcceptanceMatrix({
        ...matrix,
        gates: [
          matrix.gates[0],
          {
            ...matrix.gates[1],
            status: "passed",
            evidence: "   ",
            signedOffBy: " ",
            signedOffAt: "yesterday",
          },
        ],
      }),
    ).toThrow(/manual evidence/i);
  });

  it("rejects an acceptance matrix for a different release", () => {
    expect(() =>
      validateAcceptanceMatrix(matrix, { expectedRelease: "1.9.28" }),
    ).toThrow(/1\.9\.24.*1\.9\.28/i);
    expect(
      validateAcceptanceMatrix(matrix, { expectedRelease: "1.9.24" }),
    ).toEqual(matrix);
  });

  it("creates a commit-bound artifact without converting pending manual gates", () => {
    const report = createReleaseEvidence(matrix, {
      sha: "abc123",
      ref: "refs/heads/release/epic-12-release-confidence",
      runId: "42",
      runUrl: "https://github.com/example/run/42",
      generatedAt: "2026-10-23T15:00:00.000Z",
      jobs: { verify: "success" },
      fullBrowserMatrix: true,
    });
    expect(report).toMatchObject({
      schemaVersion: 1,
      release: "1.9.24",
      commit: "abc123",
      runId: "42",
      summary: {
        automatedPassed: 1,
        automatedFailed: 0,
        automatedPending: 0,
        manualPassed: 0,
        manualPending: 1,
      },
    });
    expect(
      report.gates.find((gate) => gate.id === "screen-reader").status,
    ).toBe("pending");
    expect(report.gates.find((gate) => gate.id === "build").status).toBe(
      "passed",
    );
  });

  it("records failed CI jobs instead of producing a success-shaped artifact", () => {
    const report = createReleaseEvidence(matrix, {
      jobs: { verify: "failure" },
    });
    expect(report.summary).toMatchObject({
      automatedPassed: 0,
      automatedFailed: 1,
      automatedPending: 0,
    });
    expect(report.gates[0].status).toBe("failed");
  });

  it("does not certify a full browser gate on an ordinary partial run", () => {
    const report = createReleaseEvidence(matrix, {
      jobs: { verify: "success" },
      fullBrowserMatrix: false,
    });
    expect(report.summary).toMatchObject({
      automatedPassed: 0,
      automatedFailed: 0,
      automatedPending: 1,
    });
    expect(report.gates[0].status).toBe("required");
    const omitted = createReleaseEvidence(matrix, {
      jobs: { verify: "success" },
    });
    expect(omitted.gates[0].status).toBe("required");
  });
});
