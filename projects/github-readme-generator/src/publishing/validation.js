import { assetPath } from "./asset-path.js";
import { workflowPath } from "../workflows/validate.js";
export const MAX_SOURCE_BYTES = 750_000;
export function target(value) {
  const { repository, branch, path } = value || {};
  if (
    typeof repository !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(
      repository,
    ) ||
    repository.split("/").some((p) => p === "." || p === "..")
  )
    throw new Error("Choose a valid owner/repository.");
  if (
    typeof branch !== "string" ||
    branch.length > 200 ||
    !branch ||
    /[\s\x00-\x1f~^:?*\[\\]/.test(branch) ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch
      .split("/")
      .some(
        (p) =>
          !p || p.startsWith(".") || p.endsWith(".") || p.endsWith(".lock"),
      ) ||
    branch === "@"
  )
    throw new Error("Choose a valid branch.");
  if (value.kind === "asset") assetPath(path);
  else if (value.kind === "workflow") workflowPath(path);
  else if (
    typeof path !== "string" ||
    path.length > 240 ||
    !/^(?:[A-Za-z0-9_-][A-Za-z0-9_. -]*\/)*README(?:\.[A-Za-z0-9_-]+)?$/i.test(
      path,
    ) ||
    path.split("/").some((p) => p.endsWith(".") || p.endsWith(" "))
  )
    throw new Error(
      "Choose a relative README file path without traversal or hidden folders.",
    );
  return {
    repository,
    branch,
    path,
    ...(["asset", "workflow"].includes(value.kind) ? { kind: value.kind } : {}),
  };
}
// Shared by writeInput and the Change set builder, so reviewed content and
// messages are judged exactly as the server judges them.
export function publishableContent(content) {
  if (
    typeof content !== "string" ||
    new TextEncoder().encode(content).length > MAX_SOURCE_BYTES
  )
    throw new Error(
      "README exceeds the 750 KB publishing limit. Download it instead.",
    );
  return content;
}
export function commitMessage(message) {
  if (
    typeof message !== "string" ||
    !message.trim() ||
    message.length > 500 ||
    /[\x00-\x1f\x7f]/.test(message)
  )
    throw new Error("Enter a commit message of 1–500 characters.");
  return message.trim();
}
// One File change of an approved Change set (ADR epic69-02): `sha` is the
// Base SHA (null only for a create) and `resultSha` the Git blob SHA of
// `content`, which the server recomputes before writing.
export function writeInput(value) {
  const result = target(value),
    content = publishableContent(value.content),
    message = commitMessage(value.message);
  if (value.sha !== null && !/^[a-f0-9]{40,64}$/.test(value.sha || ""))
    throw new Error("Reload the remote SHA before publishing.");
  if (!/^[a-f0-9]{40}$/.test(value.resultSha || ""))
    throw new Error(
      "Review the change set again: this write has no Result SHA.",
    );
  if (!/^[a-f0-9]{64}$/.test(value.changeSetId || ""))
    throw new Error("Review the change set again: this write has no id.");
  if (value.confirmed !== true)
    throw new Error("Review and confirm this write first.");
  return {
    ...result,
    content,
    message,
    sha: value.sha,
    resultSha: value.resultSha,
    changeSetId: value.changeSetId,
    confirmed: true,
  };
}
