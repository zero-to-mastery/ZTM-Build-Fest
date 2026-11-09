// Guided start state (ADR 0004): the chosen Goal and the Next steps on/off
// preference. A workspace field, never a setting, so portable projects, draft
// JSON and README exports cannot carry it.
import { portableData } from "../state/portable-data.js";
import { documentTarget, documentGroup } from "./documents.js";
export const GUIDE_VERSION = 1,
  GUIDE_LIMIT = 1024;
export const GOALS = Object.freeze({
  profile: Object.freeze({
    label: "Write my profile README",
    description: "Introduce yourself on your GitHub profile page.",
    needsNetwork: false,
  }),
  repository: Object.freeze({
    label: "Write a repository README",
    description:
      "Explain a project: what it does, how to install it and how to use it.",
    needsNetwork: false,
  }),
  audit: Object.freeze({
    label: "Audit my repository READMEs",
    description:
      "Find public repositories whose README is missing or needs attention. Needs a GitHub connection.",
    needsNetwork: true,
  }),
});
export const goalIds = Object.keys(GOALS);
// Only a Goal id string counts: Object.hasOwn alone would coerce ["audit"].
export const knownGoal = (goal) =>
  typeof goal === "string" && Object.hasOwn(GOALS, goal);
export const defaultGuide = () => ({
  version: GUIDE_VERSION,
  goal: null,
  nextSteps: true,
});
const object = (v) => v && typeof v === "object" && !Array.isArray(v);
function guideJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
// A kept guide must pass the all-drafts backup boundary unchanged: the guide
// sits one level inside the workspace, so portableData starts at depth 1. Too
// deep, or holding credential-named keys the backup would strip, means it
// could not be kept unchanged, so it is replaced by the default instead.
function keepable(value) {
  const raw = guideJson(value);
  if (raw === undefined || new TextEncoder().encode(raw).length > GUIDE_LIMIT)
    return false;
  try {
    return JSON.stringify(portableData(JSON.parse(raw), 1)) === raw;
  } catch {
    return false;
  }
}
export function validateGuide(value) {
  if (value === undefined) return defaultGuide();
  if (object(value) && value.version === GUIDE_VERSION)
    return {
      version: GUIDE_VERSION,
      goal: knownGoal(value.goal) ? value.goal : null,
      nextSteps: value.nextSteps !== false,
    };
  // Another version, or a damaged value, is kept as it is so a newer app can
  // still read it; it reads as "no Goal" until the author chooses again.
  return keepable(value) ? JSON.parse(JSON.stringify(value)) : defaultGuide();
}
export function recoverGuide(value) {
  try {
    return validateGuide(value);
  } catch {
    return defaultGuide();
  }
}
// The Goal only counts in a version-1 guide; anything else means "no Goal".
export const guideGoal = (guide) =>
  object(guide) && guide.version === GUIDE_VERSION && knownGoal(guide.goal)
    ? guide.goal
    : null;
export const nextStepsEnabled = (guide) =>
  !(object(guide) && guide.version === GUIDE_VERSION) ||
  guide.nextSteps !== false;
// An explicit choice is the only thing that replaces an unknown guide.
export function chooseGoal(guide, goal) {
  if (!knownGoal(goal)) throw Error("Choose a known Goal.");
  return {
    version: GUIDE_VERSION,
    goal,
    nextSteps: nextStepsEnabled(guide),
  };
}
const option = (id, label) => ({ id, label });
// The second step of Guided start. Each option opens an existing flow; ids are
// AppShell actions except the two blank starts. Offline, the audit stays
// visible but unavailable, with offline-capable ways to begin beside it.
export function goalOptions(goal, { online = true } = {}) {
  if (goal === "profile")
    return [
      option("templates", "Start from a profile template"),
      option("profile", "Autofill from GitHub"),
      option("blank-profile", "Start a blank profile README"),
    ];
  if (goal === "repository")
    return [
      option("repository-readme", "Build a repository README"),
      option("import", "Import existing README"),
      option("blank-repository", "Start a blank repository README"),
    ];
  if (goal === "audit")
    return online
      ? [option("repository-audit", "Open README audit")]
      : [
          {
            ...option("repository-audit", "Open README audit"),
            unavailable:
              "You are offline. README audit reads your repositories from GitHub, so it needs a connection. Import a README file or start blank now and audit later.",
          },
          option("import", "Import existing README"),
          option("blank-repository", "Start a blank repository README"),
        ];
  throw Error("Choose a known Goal.");
}
export const blankDocument = (kind) => ({
  version: 1,
  kind,
  target: null,
});

// Next steps (ADR 0005). An Arrival is the in-memory record of how the active
// document was just created or opened; it is never saved. The rule below turns
// an Arrival and cheap facts into at most three existing commands. It never
// runs analysis, fetches, applies a change or suggests publishing: each step
// only opens a tool's normal, reviewed flow.
export const ARRIVAL_KINDS = Object.freeze([
  "import",
  "audit",
  "template",
  "blank",
]);
const arrivalModes = ["new", "replace", "append", "merge"],
  arrivalOrigins = ["github", "file", "project"],
  arrivalTemplates = ["profile", "repository"];
const pick = (value, allowed) => (allowed.includes(value) ? value : null);
export function createArrival(draftId, kind, detail = {}) {
  if (typeof draftId !== "string" || !draftId)
    throw Error("An Arrival needs a document.");
  if (!ARRIVAL_KINDS.includes(kind)) throw Error("Unknown Arrival kind.");
  return {
    draftId,
    kind,
    detail: {
      mode: pick(detail?.mode, arrivalModes) || "new",
      origin: pick(detail?.origin, arrivalOrigins),
      existing: detail?.existing === true,
      template: pick(detail?.template, arrivalTemplates),
    },
  };
}
// Every command a Next step may open: existing commandGroups ids or
// data-actions, plus the two builder tabs. None writes Source, storage or
// GitHub by itself; each opens a tool whose own review applies any change.
export const NEXT_STEP_COMMANDS = Object.freeze([
  "show-health",
  "show-preview",
  "split",
  "documents",
  "drift-check",
  "profile",
  "repository-audit",
  "readme-attention",
  "templates",
  "import",
  "compatibility",
  "download",
  "sections",
  "library",
]);
// Commands that read GitHub; hidden while the browser reports it is offline.
export const NETWORK_COMMANDS = Object.freeze([
  "profile",
  "drift-check",
  "repository-audit",
  "readme-attention",
  "repository-health",
  "refresh-github",
]);
const step = (command, label, reason) => ({ command, label, reason });
const preview = () =>
  step(
    "show-preview",
    "Preview README",
    "See how GitHub will show it before you export.",
  );
const health = (reason = "Check structure, links and accessibility locally.") =>
  step("show-health", "README Health", reason);
const drift = () =>
  step(
    "drift-check",
    "Drift check",
    "Compare its commands and paths with the repository. Read-only.",
  );
const compatibility = () =>
  step(
    "compatibility",
    "Compatibility Lab",
    "Check how the Markdown renders on GitHub.",
  );
// Cheap facts about a draft: block shape, target and import source only. No
// analysis, no parsing and no I/O.
export function documentFacts(draft) {
  const blocks = Array.isArray(draft?.blocks) ? draft.blocks : [];
  const markdown = typeof draft?.markdown === "string" ? draft.markdown : "";
  return {
    blockCount: blocks.length,
    singleCustomBlock: blocks.length === 1 && blocks[0]?.type === "custom",
    markdownEmpty: !markdown.trim(),
    hasTarget: !!documentTarget(draft || {}),
    group: documentGroup(draft || {}),
    hasImportSource: !!draft?.metadata?.importSource,
  };
}
function templateKind(arrival, facts) {
  if (arrival.detail.template) return arrival.detail.template;
  if (facts.group === "repository" || facts.group === "profile")
    return facts.group;
  return facts.goal === "repository" ? "repository" : "profile";
}
function ruleSteps(arrival, facts) {
  const { kind, detail } = arrival;
  if (kind === "template")
    return templateKind(arrival, facts) === "repository"
      ? [
          step(
            "sections",
            "Replace writing prompts",
            "Open each section and replace its prompts with your project's details.",
          ),
          health(),
          facts.hasTarget
            ? preview()
            : step(
                "documents",
                "Set repository target",
                "Name the repository, branch and path this README belongs to.",
              ),
        ]
      : [
          step(
            "sections",
            "Edit your sections",
            "Every section from the template is yours to rewrite.",
          ),
          step(
            "profile",
            "Autofill from GitHub",
            "Review public profile details before anything is added.",
          ),
          preview(),
        ];
  if (kind === "import") {
    if (detail.mode === "append" || detail.mode === "merge")
      return [
        preview(),
        health("Check the combined README for gaps or repeated sections."),
        compatibility(),
      ];
    if (facts.singleCustomBlock && !facts.markdownEmpty)
      return [
        step(
          "split",
          "Split into sections",
          "Turn the imported Markdown into sections you can reorder. The exact text is kept.",
        ),
        health(),
        facts.hasTarget ? drift() : preview(),
      ];
    return [preview(), health(), facts.hasTarget ? drift() : compatibility()];
  }
  if (kind === "audit")
    return [
      health("See what the audit flagged, checked again locally."),
      ...(facts.hasTarget ? [drift()] : []),
      step(
        "readme-attention",
        "README Attention Queue",
        "Go back to your other repositories that need attention.",
      ),
    ];
  if (kind === "blank")
    return [
      step(
        "library",
        "Add a section",
        "Pick a section from the library to begin.",
      ),
      step(
        "templates",
        "Start from a template",
        "Begin with a structure instead. It opens as a new draft.",
      ),
      step(
        "import",
        "Import existing README",
        "Bring in a README you already have. You review it first.",
      ),
    ];
  return [];
}
const normalizeArrival = (arrival) =>
  arrival && ARRIVAL_KINDS.includes(arrival.kind)
    ? createArrival(arrival.draftId, arrival.kind, arrival.detail)
    : null;
// The Next steps for an Arrival: at most three, in a fixed order. Offline,
// GitHub steps are removed; with blocked storage the last step becomes an
// export so a temporary workspace is not lost.
export function nextSteps(arrival, facts = {}) {
  const normalized = normalizeArrival(arrival);
  if (!normalized) return [];
  let list = ruleSteps(normalized, facts).filter((s) =>
    NEXT_STEP_COMMANDS.includes(s.command),
  );
  if (facts.online === false)
    list = list.filter((s) => !NETWORK_COMMANDS.includes(s.command));
  if (facts.storageBlocked)
    list = [
      ...list.slice(0, 2),
      step(
        "download",
        "Export README",
        "Browser storage is unavailable, so export to keep this draft.",
      ),
    ];
  return list.slice(0, 3);
}
// True when being offline removed at least one step for this Arrival.
export function offlineHidden(arrival, facts = {}) {
  return (
    facts.online === false &&
    nextSteps(arrival, { ...facts, online: true }).some((s) =>
      NETWORK_COMMANDS.includes(s.command),
    )
  );
}
const changed = {
  replace: "Replaced this draft with the import",
  append: "Appended the import to this draft",
  merge: "Merged the import into this draft",
};
// One plain sentence saying what just happened and what did not.
export function arrivalContext(arrival) {
  const normalized = normalizeArrival(arrival);
  if (!normalized) return "";
  const { kind, detail } = normalized;
  if (kind === "import") {
    if (detail.origin === "project")
      return "Studio project opened as a new local draft. The project file is unchanged.";
    const unchanged =
      detail.origin === "file"
        ? "The file is unchanged."
        : "Nothing changed on GitHub.";
    return detail.mode === "new"
      ? `Imported into a new local draft. ${unchanged}`
      : `${changed[detail.mode]}. Undo restores the previous version. ${unchanged}`;
  }
  if (kind === "audit")
    return detail.existing
      ? "Opened your existing local document for this repository. Local edits were kept."
      : "Opened from the README audit in a new local draft. Nothing changed on GitHub.";
  if (kind === "template")
    return "Started a new local draft from a template. Every section is editable.";
  return "Started a blank local draft.";
}
// Turning Next steps on or off is an explicit choice, so like chooseGoal it
// replaces a guide of an unknown version (keeping only a known Goal).
export function setNextSteps(guide, enabled) {
  return {
    version: GUIDE_VERSION,
    goal: guideGoal(guide),
    nextSteps: enabled === true,
  };
}
