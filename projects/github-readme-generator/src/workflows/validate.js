export function workflowPath(path) {
  if (
    typeof path !== "string" ||
    !/^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.ya?ml$/.test(path)
  )
    throw new Error("Use .github/workflows/<safe-name>.yml without traversal.");
  return path;
}
export function outputPath(path) {
  if (
    typeof path !== "string" ||
    path.length > 180 ||
    !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(path) ||
    path.includes("..")
  )
    throw new Error(
      "Use a visible relative output/config path without traversal.",
    );
  return path;
}
export function validCron(value) {
  const fields = String(value).trim().split(/\s+/),
    limits = [
      [0, 59],
      [0, 23],
      [1, 31],
      [1, 12],
      [0, 6],
    ];
  if (fields.length !== 5) return false;
  return fields.every((field, i) =>
    field.split(",").every((part) => {
      const match = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
      if (!match) return false;
      if (
        match[2] &&
        (+match[2] < 1 || +match[2] > limits[i][1] - limits[i][0] + 1)
      )
        return false;
      if (match[1] === "*") return true;
      const [a, b = a] = match[1].split("-").map(Number);
      return a >= limits[i][0] && b <= limits[i][1] && a <= b;
    }),
  );
}
export function safeField(value, max = 500) {
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) ||
    value.includes("${{") ||
    /\b(?:gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/.test(
      value,
    )
  )
    throw new Error(
      "Use plain configuration text without expressions or secret values.",
    );
  return value;
}
export function actionRef(value) {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[A-Za-z0-9_.-]+$/.test(
      value,
    ) ||
    value.includes("..")
  )
    throw new Error("Enter an owner/action@version or commit ref.");
  return value;
}
export function secretName(value) {
  if (
    !/^[A-Z_][A-Z0-9_]{0,79}$/.test(value) ||
    (value.startsWith("GITHUB_") && value !== "GITHUB_TOKEN")
  )
    throw new Error(
      "Enter a secret NAME such as METRICS_TOKEN, never its value.",
    );
  return value;
}
export function workflowHealth(model, { existingNames = [] } = {}) {
  const warnings = [];
  if (!model.permissions?.contents)
    warnings.push("Declare minimal contents permissions explicitly.");
  for (const schedule of model.on?.schedule || [])
    if (!validCron(schedule.cron))
      warnings.push("Invalid five-field cron schedule.");
  if (existingNames.includes(model.name))
    warnings.push(
      "Another workflow has this name; choose a distinct display name.",
    );
  for (const job of Object.values(model.jobs || {}))
    for (const step of job.steps || []) {
      if (step.uses && !/^[^@]+@[^@]+$/.test(step.uses))
        warnings.push("Action reference is empty or missing.");
      for (const [key, value] of Object.entries(step.with || {}))
        if (
          /token|secret|password/i.test(key) &&
          !/^\$\{\{ (?:secrets\.[A-Z_][A-Z0-9_]*|github\.token) \}\}$/.test(
            String(value),
          )
        )
          warnings.push(
            "Secret input must reference a GitHub secret name, never a literal value.",
          );
    }
  for (const path of model.outputs || [])
    try {
      outputPath(path);
    } catch {
      warnings.push("Unsafe workflow output path.");
    }
  return warnings;
}
