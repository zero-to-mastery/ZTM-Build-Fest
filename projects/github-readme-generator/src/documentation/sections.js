import { projectSections } from "./project-types.js";
import { safeUrl } from "../markdown/url-safety.js";
import { mdText } from "../styling/presentation.js";
import {
  EXAMPLE_STATUSES,
  exampleMarker,
  validateExampleProvenance,
} from "./example-provenance.js";

const f = (key, label, kind = "markdown") => ({ key, label, kind });
export const documentationSections = {
  ...projectSections,
  "doc-overview": {
    name: "Overview",
    fields: [
      f("purpose", "Purpose"),
      f("audience", "Intended audience"),
      f("scope", "Scope and limitations"),
    ],
  },
  "doc-features": {
    name: "Features",
    fields: [
      f("features", "Features (one per line)", "list"),
      f("notes", "Additional notes"),
    ],
  },
  "doc-installation": {
    name: "Installation",
    fields: [
      f("packageManager", "Package manager", "text"),
      f("command", "Install command", "code"),
      f("prerequisites", "Prerequisites"),
      f("notes", "Additional notes"),
    ],
  },
  "doc-quick-start": {
    name: "Quick Start",
    fields: [
      f("prerequisites", "Prerequisites"),
      f("steps", "Quick start steps"),
      f("commands", "Quick start commands", "code"),
      f("expected", "Expected result"),
    ],
  },
  "doc-usage": {
    name: "Usage",
    fields: [
      f("instructions", "Usage instructions"),
      f("commands", "Usage commands", "code"),
      f("expected", "Expected output or behavior"),
    ],
  },
  "doc-configuration": {
    name: "Configuration",
    fields: [
      f("location", "Configuration file location", "text"),
      f("options", "Configuration options"),
      f("example", "Configuration example (placeholders only)", "code"),
      f("notes", "Additional notes"),
    ],
  },
  "doc-environment": {
    name: "Environment Variables",
    fields: [f("notes", "Environment notes")],
    rows: true,
  },
  "doc-commands": {
    name: "Commands",
    fields: [
      f("commands", "Commands", "code"),
      f("options", "Flags and options"),
      f("examples", "Command examples", "code"),
      f("notes", "Additional notes"),
    ],
  },
  "doc-api": {
    name: "API",
    fields: [
      f("overview", "API overview"),
      f("authentication", "Authentication guidance (no credentials)"),
      f("endpoints", "Endpoints or exported symbols"),
      f("request", "Request or call example", "code"),
      f("response", "Response or return example", "code"),
    ],
  },
  "doc-examples": {
    name: "Examples",
    fields: [
      f("description", "Example description"),
      f("language", "Example language", "text"),
      f("example", "Example code", "code"),
      f("expected", "Expected result"),
    ],
  },
  "doc-architecture": {
    name: "Architecture",
    fields: [
      f("overview", "Architecture overview"),
      f("components", "Components and responsibilities"),
      f("flow", "Data flow"),
      f("decisions", "Design decisions"),
    ],
  },
  "doc-testing": {
    name: "Testing",
    fields: [
      f("commands", "Test commands", "code"),
      f("testTypes", "Test types (one per line)", "list"),
      f("coverage", "Coverage notes"),
    ],
  },
  "doc-deployment": {
    name: "Deployment",
    fields: [
      f("target", "Deployment target", "text"),
      f("prerequisites", "Deployment prerequisites"),
      f("commands", "Deployment commands", "code"),
      f("verification", "Verification and rollback"),
    ],
  },
  "doc-troubleshooting": {
    name: "Troubleshooting",
    fields: [
      f("symptoms", "Symptoms"),
      f("causes", "Possible causes"),
      f("solutions", "Solutions"),
      f("support", "Where to get help"),
    ],
  },
  "doc-contributing": {
    name: "Contributing",
    fields: [
      f("setup", "Contributor setup"),
      f("workflow", "Contribution workflow"),
      f("checks", "Required checks", "code"),
      f("guidelines", "Contribution guidelines"),
    ],
  },
  "doc-security": {
    name: "Security",
    fields: [
      f("reporting", "Private vulnerability reporting instructions"),
      f("versions", "Supported versions"),
      f("policy", "Security policy and scope"),
    ],
  },
  "doc-license": {
    name: "License",
    fields: [
      f("license", "License name (confirm repository terms)", "text"),
      f("file", "License file path", "text"),
      f("notes", "License notes"),
    ],
  },
  "doc-roadmap": {
    name: "Roadmap",
    fields: [
      f("planned", "Planned work (one per line)", "list"),
      f("progress", "Current progress"),
      f("notes", "Scope and timing notes"),
    ],
  },
};

export const environmentFields = [
  { key: "name", label: "Variable name", type: "text" },
  { key: "required", label: "Required", type: "checkbox" },
  { key: "description", label: "Variable description", type: "textarea" },
  {
    key: "placeholder",
    label: "Example placeholder (never a real secret)",
    type: "text",
  },
];
export const emptyEnvironmentRow = () => ({
  name: "",
  required: false,
  description: "",
  placeholder: "",
});
export function documentationDefaults(type) {
  const definition = documentationSections[type];
  if (!definition) throw Error("Unknown documentation section.");
  const codeFields = definition.fields.filter((field) => field.kind === "code");
  return {
    version: 1,
    title: definition.name,
    ...Object.fromEntries(definition.fields.map((field) => [field.key, ""])),
    ...(definition.rows || definition.rowFields ? { items: [] } : {}),
    ...(codeFields.length
      ? {
          exampleProvenance: Object.fromEntries(
            codeFields.map((field) => [
              field.key,
              { status: "placeholder", basis: "" },
            ]),
          ),
        }
      : {}),
  };
}
export function documentationType(title) {
  const exact = Object.entries(documentationSections).find(
    ([, definition]) => definition.name.toLowerCase() === title.toLowerCase(),
  );
  return (
    exact?.[0] ||
    {
      controls: "doc-controls",
      "save and data": "doc-save-data",
      setup: "doc-installation",
      purpose: "doc-overview",
      environment: "doc-environment",
      "build instructions": "doc-installation",
      "how to run": "doc-quick-start",
    }[title.toLowerCase()] ||
    null
  );
}
function fence(value, language) {
  const longest = (value.match(/`+/g) || []).reduce(
    (length, run) => Math.max(length, run.length),
    0,
  );
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}${language}\n${value}\n${ticks}`;
}
export function serializeDocumentation(type, settings) {
  const definition = documentationSections[type];
  if (!definition || settings.version !== 1)
    throw Error("Unsupported documentation section version.");
  const parts = [`## ${mdText(settings.title || definition.name)}`];
  if (definition.rows) {
    if (!Array.isArray(settings.items) || settings.items.length > 200)
      throw Error("Use at most 200 environment variable rows.");
    parts.push(
      "Use example placeholders only. Keep real secrets outside version control; document placeholders in .env.example instead.",
    );
    const rows = settings.items.filter(
      (row) =>
        row &&
        [row.name, row.description, row.placeholder].some((value) =>
          String(value || "").trim(),
        ),
    );
    for (const row of rows) {
      if (
        typeof row.name !== "string" ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.name.trim())
      )
        throw Error(
          "Variable names must contain letters, digits or underscores and cannot start with a digit.",
        );
      if (typeof row.required !== "boolean")
        throw Error("Choose whether each variable is required.");
    }
    if (rows.length)
      parts.push(
        "| Name | Required | Description | Example placeholder |\n| --- | --- | --- | --- |\n" +
          rows
            .map(
              (row) =>
                `| ${mdText(row.name.trim())} | ${row.required ? "Yes" : "No"} | ${mdText(row.description)} | ${mdText(row.placeholder)} |`,
            )
            .join("\n"),
      );
  }
  if (definition.rowFields) {
    if (!Array.isArray(settings.items) || settings.items.length > 200)
      throw Error("Use at most 200 documentation rows.");
    const rows = settings.items.filter(
      (row) =>
        row &&
        definition.rowFields.some(
          (field) =>
            field.type !== "checkbox" && String(row[field.key] || "").trim(),
        ),
    );
    for (const row of rows) {
      if (typeof row.name !== "string" || !row.name.trim())
        throw Error(
          `Enter ${definition.rowFields[0].label.toLowerCase()} for each row.`,
        );
      for (const field of definition.rowFields) {
        if (field.type === "checkbox" && typeof row[field.key] !== "boolean")
          throw Error(`Choose ${field.label.toLowerCase()} for each row.`);
        if (field.type !== "checkbox" && typeof row[field.key] !== "string")
          throw Error(`Enter text for ${field.label}.`);
      }
    }
    if (definition.rowMode === "images") {
      for (const row of rows) {
        const url = safeUrl(row.name, { image: true });
        if (!url) throw Error("Enter a safe image URL or repository path.");
        if (!row.alt.trim()) throw Error("Add meaningful screenshot alt text.");
        const destination = url.replace(/[()\s<>]/g, (character) =>
          encodeURIComponent(character)
            .replace(/\(/g, "%28")
            .replace(/\)/g, "%29"),
        );
        parts.push(
          `![${mdText(row.alt)}](${destination})${row.caption.trim() ? "\n\n" + mdText(row.caption) : ""}`,
        );
      }
    } else if (rows.length) {
      const columns = definition.rowFields;
      parts.push(
        `| ${columns.map((field) => mdText(field.label)).join(" | ")} |\n| ${columns.map(() => "---").join(" | ")} |\n` +
          rows
            .map(
              (row) =>
                `| ${columns.map((field) => (field.type === "checkbox" ? (row[field.key] ? "Yes" : "No") : mdText(row[field.key]))).join(" | ")} |`,
            )
            .join("\n"),
      );
    }
  }
  for (const field of definition.fields) {
    const value = settings[field.key];
    if (value == null || value === "") continue;
    if (typeof value !== "string")
      throw Error(`Enter text for ${field.label}.`);
    if (!value.trim()) continue;
    const language = field.language
      ? field.language
      : (type === "doc-examples" || definition.dynamicLanguage) &&
          /^[\w+-]{1,30}$/.test(settings.language || "")
        ? settings.language
        : [
              "doc-installation",
              "doc-quick-start",
              "doc-usage",
              "doc-commands",
              "doc-testing",
              "doc-deployment",
              "doc-contributing",
            ].includes(type)
          ? "sh"
          : "text";
    if (
      field.kind === "link" &&
      (!/^https?:\/\//i.test(value) || !safeUrl(value, { relative: false }))
    )
      throw Error(`Enter a safe HTTP(S) URL for ${field.label}.`);
    const content =
      field.kind === "link"
        ? `[${mdText(field.label)}](${value.replace(/[()\s<>]/g, (character) => encodeURIComponent(character).replace(/\(/g, "%28").replace(/\)/g, "%29"))})`
        : field.kind === "code"
          ? (() => {
              const provenance = settings.exampleProvenance?.[field.key];
              const shaped =
                provenance &&
                typeof provenance === "object" &&
                !Array.isArray(provenance) &&
                EXAMPLE_STATUSES.includes(provenance.status) &&
                typeof provenance.basis === "string";
              return `${shaped ? exampleMarker(validateExampleProvenance(provenance).status, value) + "\n" : ""}${fence(value, language)}`;
            })()
          : field.kind === "list"
            ? value
                .split(/\r?\n/)
                .filter((line) => line.trim())
                .map((line) => `- ${mdText(line.trim())}`)
                .join("\n")
            : field.kind === "text"
              ? mdText(value)
              : value;
    parts.push(
      `### ${mdText(field.label.replace(/ \(.*\)$/, ""))}\n\n${content}`,
    );
  }
  if (parts.length === 1)
    parts.push(
      "<!-- TODO: Add verified project-specific information, or remove this section if it does not apply. -->",
    );
  return parts.join("\n\n");
}
