import { resolve } from "node:path";

const STATUSES = new Set(["required", "pending", "passed", "failed"]);
const present = (value, limit) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= limit;
const strictIsoTime = (value) => {
  if (!present(value, 64)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
};

export function getAcceptanceMatrixPath(root, release) {
  return resolve(root, `docs/releases/${release}-acceptance.json`);
}

export function validateAcceptanceMatrix(value, context = {}) {
  if (!value || value.schemaVersion !== 1 || typeof value.release !== "string")
    throw new Error(
      "Acceptance matrix must use schema version 1 and name a release.",
    );
  if (context.expectedRelease && value.release !== context.expectedRelease)
    throw new Error(
      `Acceptance matrix release ${value.release} does not match expected release ${context.expectedRelease}.`,
    );
  if (!Array.isArray(value.gates) || !value.gates.length)
    throw new Error("Acceptance matrix must contain gates.");
  const ids = new Set();
  for (const gate of value.gates) {
    if (!gate || typeof gate.id !== "string" || ids.has(gate.id))
      throw new Error(`Duplicate or invalid gate: ${gate?.id || "unnamed"}.`);
    ids.add(gate.id);
    if (!["automated", "manual"].includes(gate.kind))
      throw new Error(`${gate.id} has an invalid gate kind.`);
    if (!STATUSES.has(gate.status))
      throw new Error(`${gate.id} has an invalid status.`);
    if (
      gate.requiresFullBrowserMatrix !== undefined &&
      typeof gate.requiresFullBrowserMatrix !== "boolean"
    )
      throw new Error(
        `${gate.id} has an invalid full-browser-matrix requirement.`,
      );
    if (
      gate.kind === "automated" &&
      (!present(gate.evidence, 2_000) ||
        !Array.isArray(gate.jobs) ||
        !gate.jobs.length ||
        gate.jobs.some((job) => !present(job, 100)))
    )
      throw new Error(
        `${gate.id} must name its automated evidence and CI jobs.`,
      );
    if (gate.kind === "manual" && !present(gate.instructions, 4_000))
      throw new Error(`${gate.id} must include manual instructions.`);
    if (
      gate.kind === "manual" &&
      gate.status === "passed" &&
      (!present(gate.evidence, 4_000) ||
        !present(gate.signedOffBy, 200) ||
        !strictIsoTime(gate.signedOffAt))
    )
      throw new Error(
        `${gate.id} cannot pass without manual evidence and signoff.`,
      );
  }
  return value;
}

export function createReleaseEvidence(matrix, context = {}) {
  const accepted = validateAcceptanceMatrix(structuredClone(matrix));
  const jobs = context.jobs || {};
  const gates = accepted.gates.map((gate) => {
    if (gate.kind !== "automated") return gate;
    const outcomes = gate.jobs.map((job) => jobs[job]).filter(Boolean);
    const status =
      (!gate.requiresFullBrowserMatrix || context.fullBrowserMatrix === true) &&
      outcomes.length === gate.jobs.length &&
      outcomes.every((outcome) => outcome === "success")
        ? "passed"
        : outcomes.some((outcome) =>
              ["failure", "cancelled", "timed_out", "action_required"].includes(
                outcome,
              ),
            )
          ? "failed"
          : "required";
    return { ...gate, status };
  });
  const automated = gates.filter((gate) => gate.kind === "automated");
  const manual = gates.filter((gate) => gate.kind === "manual");
  return {
    schemaVersion: 1,
    release: accepted.release,
    generatedAt: context.generatedAt || new Date().toISOString(),
    commit: context.sha || "local-uncommitted",
    ref: context.ref || "local",
    runId: context.runId || null,
    runUrl: context.runUrl || null,
    jobs,
    summary: {
      automatedPassed: automated.filter((gate) => gate.status === "passed")
        .length,
      automatedFailed: automated.filter((gate) => gate.status === "failed")
        .length,
      automatedPending: automated.filter((gate) => gate.status === "required")
        .length,
      manualPassed: manual.filter((gate) => gate.status === "passed").length,
      manualPending: manual.filter((gate) => gate.status !== "passed").length,
    },
    gates,
  };
}
