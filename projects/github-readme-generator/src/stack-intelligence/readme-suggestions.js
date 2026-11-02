import { stackDNA } from "./dna.js";
import { buildLinkedBadge } from "../badges/shields.js";

const code = (text) => `\n\n\`\`\`sh\n${text}\n\`\`\``;
export function readmeSuggestions(record) {
  if (!record || record.status === "failed") return [];
  const suggestions = [];
  const reviewProvenance = (item = {}) => ({
    repository: item.repository || record.repository || "",
    branch: item.branch || record.ref || "",
    project: item.project || "",
    manifest: item.manifest || "",
    blobSha: item.blobSha || "",
    section: item.section || "",
    line: Number.isSafeInteger(item.line) && item.line > 0 ? item.line : null,
    observedAt: Number.isFinite(item.observedAt)
      ? item.observedAt
      : (record.observedAt ?? record.checkedAt ?? null),
    basis: item.basis || "",
    source: item.source || "",
    claim: item.claim || "",
  });
  const add = (id, title, markdown, evidence, caveat, provenance = []) =>
    suggestions.push({
      id,
      title,
      markdown,
      evidence,
      caveat,
      provenance: provenance.map(reviewProvenance).slice(0, 100),
    });
  const dna = stackDNA([record]);
  const known = dna.technologies.filter((t) => t.category !== "Unknown");
  // A technology whose every declaration is conditional or ambiguous is shown,
  // never promoted: it is left out of the Detected stack section and gets no
  // badge, and is offered as its own labelled suggestion instead.
  const certain = known.filter((t) => !t.uncertainOnly);
  const uncertain = known.filter((t) => t.uncertainOnly);
  // Evidence names its Confidence basis; metadata has none.
  const basis = (e) => (e.basis ? ` · basis: ${e.basis}` : " · metadata");
  const section = (heading, technologies) =>
    `## ${heading}\n\n` +
    dna.groups
      .map((g) => ({
        ...g,
        technologies: g.technologies.filter((t) => technologies.includes(t)),
      }))
      .filter((g) => g.technologies.length)
      .map(
        (g) => `- ${g.name}: ${g.technologies.map((t) => t.name).join(" · ")}`,
      )
      .join("\n");
  const evidence = (technologies) =>
    technologies
      .flatMap((t) =>
        t.evidence.map((e) => `${t.name}: ${e.source}${basis(e)}`),
      )
      .slice(0, 100);
  const provenance = (technologies) =>
    technologies
      .flatMap((technology) =>
        technology.evidence.map((item) => ({
          ...item,
          claim: technology.name,
        })),
      )
      .slice(0, 100);
  if (certain.length) {
    add(
      "stack",
      "Detected stack section",
      section("Detected stack", certain),
      evidence(certain),
      "Declarations and primary-language metadata, not proficiency or verified production use. Unknown dependencies are omitted." +
        (uncertain.length
          ? " Technologies with only uncertain evidence are left out and offered separately."
          : ""),
      provenance(certain),
    );
    for (const t of certain)
      add(
        `badge:${t.id}`,
        `${t.name} badge`,
        buildLinkedBadge({
          label: t.name,
          color: "555555",
          alt: `${t.name} — repository evidence`,
        }),
        t.evidence.map((e) => e.source + basis(e)),
        "Optional presentation. Rendering this badge contacts Shields.io; it does not certify skill.",
        t.evidence.map((item) => ({ ...item, claim: t.name })),
      );
  }
  if (uncertain.length)
    add(
      "stack:uncertain",
      "Technologies with only uncertain evidence",
      section("Possibly in the stack", uncertain),
      evidence(uncertain),
      `Only uncertain evidence: every declaration of ${uncertain.map((t) => t.name).join(", ")} is conditional or ambiguous, so it may not be active in every build or install. It is not part of the Detected stack section and no badge is suggested. Select it only after confirming it applies.`,
      provenance(uncertain),
    );
  // Commands, managers and package links come from root Manifests only: a
  // command for a Workspace member or Nested project would need its own
  // working directory, which is not offered yet.
  for (const manifest of (record.manifests || []).filter((m) => !m.project)) {
    const { readme = {} } = manifest;
    // `file` is the registry name; older records only carry `path`.
    const path = manifest.file || manifest.path;
    const manifestProvenance = (section, basis = "") => [
      {
        repository: record.repository,
        branch: record.ref,
        project: manifest.project,
        manifest: manifest.path,
        blobSha: manifest.sha,
        section,
        observedAt: record.observedAt ?? record.checkedAt,
        basis,
      },
    ];
    const suggest = (key, title, source, evidence, options = {}) => {
      const {
        caveat = "Conventional command, not verified against this repository. Review prerequisites, working directory and safety before documenting or running it.",
        section = "manifest presence",
        basis = "",
      } = options;
      add(
        `${path}:${key}`,
        title,
        source,
        [`${path}: ${evidence}`],
        caveat,
        manifestProvenance(section, basis).map((item) => ({
          ...item,
          claim: title,
        })),
      );
    };
    if (path === "package.json") {
      const manager = readme.packageManager || "npm";
      suggest(
        "manager",
        "Package manager",
        `Package manager: ${manager}.`,
        readme.packageManager
          ? "packageManager declaration"
          : "package.json; npm is a suggested fallback, not detected",
        {
          caveat:
            "Confirm the manager/version against repository instructions and lockfiles; lockfiles were not read.",
          section: readme.packageManager
            ? "packageManager"
            : "manifest presence",
          basis: readme.packageManager ? "explicit" : "",
        },
      );
      suggest(
        "install",
        "Install Node dependencies",
        "## Installation" + code(`${manager} install`),
        "package.json present",
      );
      for (const key of readme.scripts || [])
        if (["test", "build"].includes(key))
          suggest(
            key,
            key === "test" ? "Testing command" : "Build command",
            `## ${key === "test" ? "Testing" : "Build"}` +
              code(`${manager} run ${key}`),
            `scripts.${key} declared`,
            {
              caveat:
                "Script body was not retained, inspected for safety or executed. Review the script and any lifecycle hooks before running it.",
              section: `scripts.${key}`,
              basis: "explicit",
            },
          );
      if (readme.packageName)
        suggest(
          "link",
          "npm package link",
          `[Package on npm](https://www.npmjs.com/package/${encodeURIComponent(readme.packageName)})`,
          "name declaration",
          {
            caveat:
              "Package identity is declared; publication, ownership and availability are not verified.",
            section: "name",
            basis: "explicit",
          },
        );
    } else if (path === "Cargo.toml") {
      suggest(
        "manager",
        "Rust package manager",
        "Package manager: Cargo.",
        "Cargo manifest present",
      );
      for (const key of ["build", "test"])
        suggest(
          key,
          `Cargo ${key} command`,
          `## ${key === "test" ? "Testing" : "Build"}` + code(`cargo ${key}`),
          "Cargo manifest present",
        );
      suggest(
        "install",
        "Rust dependency setup",
        "## Installation\n\nInstall the Rust toolchain, then fetch declared dependencies:" +
          code("cargo fetch"),
        "Cargo manifest present",
      );
      if (readme.packageName)
        suggest(
          "link",
          "Crate links",
          `[crates.io](https://crates.io/crates/${encodeURIComponent(readme.packageName)}) · [docs.rs](https://docs.rs/${encodeURIComponent(readme.packageName)})`,
          "package.name declaration",
          {
            caveat:
              "Publication, ownership and documentation availability are not verified.",
            section: "package.name",
            basis: "explicit",
          },
        );
    } else if (path === "pyproject.toml" || path === "requirements.txt") {
      suggest(
        "manager",
        "Python package manager suggestion",
        "Package manager suggestion: pip.",
        "Python manifest present",
        {
          caveat:
            "pip is a convention, not a detected manager. Confirm Poetry/uv or other repository-specific workflows first.",
        },
      );
      suggest(
        "install",
        "Install Python dependencies",
        "## Installation" +
          code(
            `python -m pip install ${path === "requirements.txt" ? "-r requirements.txt" : "."}`,
          ),
        "Python manifest present",
        {
          caveat:
            "Use an appropriate virtual environment. A pyproject may be non-installable; inspect build configuration and repository instructions first.",
        },
      );
      if (readme.packageName)
        suggest(
          "link",
          "Python package link",
          `[Package on PyPI](https://pypi.org/project/${encodeURIComponent(readme.packageName)}/)`,
          "project/package name declaration",
          {
            caveat: "Publication, ownership and availability are not verified.",
            section:
              path === "pyproject.toml" ? "project.name" : "manifest presence",
            basis: path === "pyproject.toml" ? "explicit" : "",
          },
        );
    } else if (path === "go.mod") {
      suggest(
        "manager",
        "Go module tooling",
        "Dependencies: Go modules.",
        "go.mod present",
      );
      for (const [key, command] of [
        ["install", "go mod download"],
        ["test", "go test ./..."],
        ["build", "go build ./..."],
      ])
        suggest(
          key,
          `Go ${key} command`,
          `## ${key === "install" ? "Installation" : key === "test" ? "Testing" : "Build"}` +
            code(command),
          "go.mod present",
        );
    }
  }
  const pytest = (record.dependencies || []).find(
    (dependency) =>
      dependency.ecosystem === "python" &&
      dependency.name === "pytest" &&
      !dependency.project,
  );
  if (pytest)
    add(
      "python:test",
      "Python testing command",
      "## Testing" + code("python -m pytest"),
      ["pytest direct dependency declaration"],
      "Confirm test paths, environment and repository-specific options. Not executed or verified.",
      (pytest.evidence || []).map((item) => ({
        ...item,
        claim: "Python testing command",
      })),
    );
  return suggestions;
}
