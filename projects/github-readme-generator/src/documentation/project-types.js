const field = (key, label, kind = "markdown", language) => ({
  key,
  label,
  kind,
  ...(language ? { language } : {}),
});
const row = (key, label, type = "text") => ({ key, label, type });
export const projectSections = {
  "doc-cli": {
    name: "CLI Reference",
    fields: [
      field("syntax", "Command syntax", "code", "sh"),
      field("commands", "Commands", "code", "sh"),
      field("examples", "CLI examples", "code", "sh"),
      field("notes", "CLI notes"),
    ],
    rowFields: [
      row("name", "Flag or option"),
      row("alias", "Short alias"),
      row("value", "Accepted value"),
      row("description", "Option description", "textarea"),
    ],
    addLabel: "Add flag or option",
  },
  "doc-endpoint": {
    name: "API Endpoint",
    fields: [
      field("authentication", "Authentication (placeholders only)"),
      field("method", "HTTP method", "text"),
      field("path", "Endpoint path", "text"),
      field("request", "Request example", "code", "http"),
      field("response", "Response example", "code", "http"),
      field("notes", "Endpoint notes"),
    ],
    rowFields: [
      row("name", "Parameter name"),
      row("location", "Parameter location"),
      row("required", "Required", "checkbox"),
      row("valueType", "Parameter type"),
      row("description", "Parameter description", "textarea"),
    ],
    addLabel: "Add parameter",
    guidance:
      "Document authentication with placeholders, never real tokens or credentials. Duplicate this section for another endpoint.",
  },
  "doc-library": {
    name: "Library Guide",
    fields: [
      field("language", "Example language", "text"),
      field("import", "Import statement", "code"),
      field("example", "Basic example", "code"),
      field("surface", "API surface"),
      field("compatibility", "Compatibility"),
    ],
    dynamicLanguage: true,
  },
  "doc-gameplay": {
    name: "Gameplay",
    fields: [
      field("objective", "Game objective"),
      field("rules", "Gameplay rules"),
      field("progression", "Progression and modes"),
    ],
  },
  "doc-controls": {
    name: "Game Controls",
    fields: [field("notes", "Control notes")],
    rowFields: [
      row("name", "Control input"),
      row("action", "Game action"),
      row("device", "Input device"),
    ],
    addLabel: "Add control",
  },
  "doc-save-data": {
    name: "Save and Data Behavior",
    fields: [
      field("location", "Save location", "text"),
      field("persistence", "What is saved and when"),
      field("reset", "Reset or delete saves"),
      field("portability", "Backup, portability and privacy"),
    ],
  },
  "doc-cargo": {
    name: "Cargo Dependency",
    fields: [
      field("dependency", "Cargo.toml dependency", "code", "toml"),
      field("features", "Cargo features (one per line)", "list"),
      field("example", "Rust example", "code", "rust"),
      field("compatibility", "Rust compatibility notes"),
    ],
    guidance:
      "Enter the actual dependency name, version and features. These are not inferred or checked against the registry.",
  },
  "doc-crate-links": {
    name: "Crate Links",
    fields: [
      field("docs", "docs.rs URL", "link"),
      field("crate", "crates.io URL", "link"),
      field("notes", "Registry and documentation notes"),
    ],
  },
  "doc-demo": {
    name: "Demo",
    fields: [
      field("url", "Demo URL", "link"),
      field("instructions", "Demo instructions"),
      field("limitations", "Demo limitations"),
    ],
  },
  "doc-screenshots": {
    name: "Screenshots",
    fields: [field("notes", "Screenshot notes")],
    rowFields: [
      row("name", "Image URL or repository path"),
      row("alt", "Screenshot alt text"),
      row("caption", "Screenshot caption"),
    ],
    addLabel: "Add screenshot",
    rowMode: "images",
    guidance:
      "Use a repository asset path or an HTTP(S) image URL and meaningful alt text. Commit local assets yourself. Remote preview contacts its image host.",
  },
};

export const documentationProfiles = {
  generic: { name: "Generic", types: [] },
  cli: {
    name: "CLI",
    types: ["doc-installation", "doc-cli", "doc-configuration"],
  },
  api: {
    name: "API",
    types: ["doc-installation", "doc-endpoint", "doc-environment"],
  },
  library: {
    name: "Library / package",
    types: [
      "doc-installation",
      "doc-library",
      "doc-examples",
      "doc-contributing",
    ],
  },
  game: {
    name: "Game",
    types: [
      "doc-gameplay",
      "doc-controls",
      "doc-quick-start",
      "doc-screenshots",
      "doc-save-data",
    ],
  },
  "rust-crate": {
    name: "Rust Crate",
    types: ["doc-cargo", "doc-features", "doc-examples", "doc-crate-links"],
  },
  "web-app": {
    name: "Web App",
    types: [
      "doc-demo",
      "doc-screenshots",
      "doc-installation",
      "doc-environment",
      "doc-architecture",
      "doc-testing",
      "doc-deployment",
    ],
  },
};
export function documentationProfile(type) {
  if (["npm-package", "python-package"].includes(type)) return "library";
  if (type === "pwa") return "web-app";
  return Object.hasOwn(documentationProfiles, type) ? type : "generic";
}
export const projectTemplateSections = {
  cli: ["Overview", "Installation", "CLI reference", "Configuration"],
  api: ["Overview", "Setup", "API endpoint", "Environment"],
  library: ["Purpose", "Installation", "Library guide", "Contributing"],
  "npm-package": [
    "Purpose",
    "Installation",
    "Library guide",
    "Testing",
    "Contributing",
  ],
  "python-package": [
    "Purpose",
    "Installation",
    "Library guide",
    "Testing",
    "Contributing",
  ],
  game: [
    "Overview",
    "Gameplay",
    "Controls",
    "How to run",
    "Screenshots",
    "Save and data",
    "Build instructions",
  ],
  "rust-crate": [
    "Purpose",
    "Cargo dependency",
    "Features",
    "Minimum Rust version",
    "Examples",
    "Crate links",
  ],
  "web-app": [
    "Overview",
    "Demo",
    "Screenshots",
    "Setup",
    "Environment",
    "Architecture",
    "Testing",
    "Deployment",
  ],
};
