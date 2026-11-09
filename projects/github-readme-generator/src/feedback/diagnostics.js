const SCENARIOS = new Set([
  "authoring",
  "import",
  "offline-recovery",
  "review",
  "publishing-review",
]);
const OUTCOMES = new Set([
  "completed",
  "completed-with-friction",
  "not-completed",
]);
const FRICTION = new Set([
  "navigation",
  "wording",
  "keyboard",
  "visual",
  "recovery-copy",
  "performance",
]);

const bucket = (value, limits, labels) => {
  const count = Math.max(0, Number.isFinite(value) ? Math.floor(value) : 0);
  const at = limits.findIndex((limit) => count <= limit);
  return at < 0 ? labels.at(-1) : labels[at];
};

export function buildFeedbackDiagnostics(input = {}) {
  if (input.consent !== true)
    throw new Error("Opt in before creating a local feedback export.");
  const feedback = {};
  if (SCENARIOS.has(input.scenario)) feedback.scenario = input.scenario;
  if (OUTCOMES.has(input.outcome)) feedback.outcome = input.outcome;
  const friction = [
    ...new Set(
      (Array.isArray(input.friction) ? input.friction : []).filter((item) =>
        FRICTION.has(item),
      ),
    ),
  ];
  if (friction.length) feedback.friction = friction;
  return {
    schemaVersion: 1,
    createdAt: input.now || new Date().toISOString(),
    app: {
      version: String(input.appVersion || "unknown"),
      online: input.online !== false,
      storageStatus: ["saved", "temporary", "failed"].includes(
        input.storageStatus,
      )
        ? input.storageStatus
        : "saved",
      reducedMotion: input.reducedMotion === true,
    },
    workspace: {
      draftCount: bucket(
        input.draftCount,
        [0, 1, 5, 20, 100],
        ["0", "1", "2–5", "6–20", "21–100", "101+"],
      ),
      markdownSize: bucket(
        input.totalMarkdownLength,
        [0, 10_240, 102_400, 512_000],
        ["0 KB", "1–10 KB", "11–100 KB", "101–500 KB", "500 KB+"],
      ),
      blockCount: bucket(
        input.blockCount,
        [0, 10, 50, 100, 500],
        ["0", "1–10", "11–50", "51–100", "101–500", "501+"],
      ),
    },
    feedback,
  };
}
