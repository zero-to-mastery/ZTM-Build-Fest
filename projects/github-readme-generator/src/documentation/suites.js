import { createBlock } from "../markdown/serialize.js";
import { newDraft } from "../state/drafts.js";
import { uniqueName } from "../state/workspace-backup.js";

const catalog = Object.freeze({
  readme: {
    id: "readme",
    path: "README.md",
    title: "Project README",
    reason: "Give readers the project overview and first steps.",
    markdown:
      "# Project name\n\nDescribe what this project does and who it is for.\n",
  },
  contributing: {
    id: "contributing",
    path: "CONTRIBUTING.md",
    title: "Contributing guide",
    reason:
      "Explain the reviewed contribution workflow when outside changes are welcome.",
    markdown:
      "# Contributing\n\nDescribe how contributors can propose and verify changes.\n",
  },
  security: {
    id: "security",
    path: "SECURITY.md",
    title: "Security policy",
    reason:
      "Document a private reporting route and supported-version policy when applicable.",
    markdown:
      "# Security policy\n\nDescribe how security reports should be submitted.\n",
  },
  support: {
    id: "support",
    path: "SUPPORT.md",
    title: "Support guide",
    reason:
      "Tell players or users where to ask for help when support is offered.",
    markdown:
      "# Support\n\nDescribe the supported help channels and information to include.\n",
  },
  api: {
    id: "api",
    path: "docs/API.md",
    title: "API reference",
    reason:
      "Describe public interfaces, authentication, parameters and response shapes.",
    markdown:
      "# API reference\n\nDescribe verified public interfaces and their contracts.\n",
  },
  cli: {
    id: "cli",
    path: "docs/CLI.md",
    title: "CLI reference",
    reason: "Document verified commands, arguments, options and examples.",
    markdown:
      "# CLI reference\n\nDescribe verified commands, arguments and options.\n",
  },
  architecture: {
    id: "architecture",
    path: "docs/ARCHITECTURE.md",
    title: "Architecture guide",
    reason:
      "Explain system boundaries and decisions when maintainers need that context.",
    markdown:
      "# Architecture\n\nDescribe the system boundaries and important design decisions.\n",
  },
  deployment: {
    id: "deployment",
    path: "docs/DEPLOYMENT.md",
    title: "Deployment guide",
    reason: "Document the verified release and deployment process.",
    markdown:
      "# Deployment\n\nDescribe prerequisites, environments and the verified deployment process.\n",
  },
  gameplay: {
    id: "gameplay",
    path: "docs/GAMEPLAY.md",
    title: "Gameplay guide",
    reason:
      "Explain verified objectives, controls, progression and save behavior.",
    markdown:
      "# Gameplay\n\nDescribe the objectives, controls, progression and save behavior.\n",
  },
});

const profiles = Object.freeze({
  generic: ["readme", "contributing", "security"],
  cli: ["readme", "contributing", "security", "cli"],
  api: ["readme", "contributing", "security", "api", "architecture"],
  library: ["readme", "contributing", "security", "api"],
  game: ["readme", "contributing", "support", "gameplay"],
  "web-app": [
    "readme",
    "contributing",
    "security",
    "architecture",
    "deployment",
  ],
});
const utf8 = new TextEncoder();

export const documentationSuiteProjectTypes = Object.freeze(
  Object.keys(profiles),
);

export function documentationSuiteTemplates(projectType) {
  const ids = profiles[projectType];
  if (!ids) throw Error("Choose a supported documentation project type.");
  return ids.map((id) => ({ ...catalog[id], selected: false }));
}

export function createDocumentationSuite(projectType, selected) {
  const options = documentationSuiteTemplates(projectType);
  if (!Array.isArray(selected) || !selected.length)
    throw Error("Choose at least one document for this suite.");
  if (selected.length > 8 || new Set(selected).size !== selected.length)
    throw Error("Choose each documentation file once, up to eight files.");
  const chosen = new Set(selected);
  if (selected.some((id) => !options.some((item) => item.id === id)))
    throw Error("The documentation suite contains an unsupported file.");
  return {
    version: 1,
    projectType,
    documents: options
      .filter((item) => chosen.has(item.id))
      .map(({ selected: _selected, ...item }) => item),
  };
}

export function validateDocumentationSuite(value) {
  if (!value || value.version !== 1 || typeof value.projectType !== "string")
    throw Error("The documentation suite manifest is invalid.");
  if (!Array.isArray(value.documents) || !value.documents.length)
    throw Error("Choose at least one document for this suite.");
  const ids = value.documents.map((item) => item?.id);
  if (ids.length > 8 || new Set(ids).size !== ids.length)
    throw Error("Choose each documentation file once, up to eight files.");
  const expected = createDocumentationSuite(value.projectType, ids);
  let totalBytes = 0;
  const documents = expected.documents.map((template, index) => {
    const item = value.documents[index];
    if (!item || item.path !== template.path)
      throw Error(`The ${template.id} document has a changed path.`);
    if (item.title !== template.title || item.reason !== template.reason)
      throw Error(`The ${template.id} document template was changed.`);
    if (typeof item.markdown !== "string" || !item.markdown.trim())
      throw Error(`The ${template.path} document needs starting Markdown.`);
    const bytes = utf8.encode(item.markdown).byteLength;
    if (bytes > 100_000)
      throw Error(`The ${template.path} document is too large.`);
    totalBytes += bytes;
    return { ...template, markdown: item.markdown };
  });
  if (totalBytes > 400_000)
    throw Error("The documentation suite is too large.");
  return { version: 1, projectType: value.projectType, documents };
}

export function planDocumentationSuiteDrafts(value, existing) {
  const manifest = validateDocumentationSuite(value);
  const paths = new Set(
    existing.flatMap((draft) => {
      const path = draft.metadata?.documentationSuite?.path;
      return typeof path === "string" ? [path.toLowerCase()] : [];
    }),
  );
  for (const document of manifest.documents)
    if (paths.has(document.path.toLowerCase()))
      throw Error(`${document.path} already exists in this workspace.`);
  const drafts = [];
  for (const document of manifest.documents) {
    const draft = newDraft(
      uniqueName(document.path, [...existing, ...drafts]),
      [createBlock("custom", { markdown: document.markdown })],
    );
    draft.metadata = {
      workspaceDocument: { version: 1, kind: "local", target: null },
      documentationSuite: {
        version: 1,
        projectType: manifest.projectType,
        id: document.id,
        path: document.path,
      },
    };
    drafts.push(draft);
  }
  return drafts;
}
