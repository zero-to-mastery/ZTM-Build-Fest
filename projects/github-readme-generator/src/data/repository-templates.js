import { projectTemplateSections } from "../documentation/project-types.js";
import {
  documentationType,
  documentationDefaults,
} from "../documentation/sections.js";
import { createBlock, text, html, safeUrl } from "../markdown/serialize.js";

export const repositoryTemplates = [
  {
    id: "web-app",
    name: "Web App",
    sections: [
      "Overview",
      "Demo and screenshots",
      "Setup",
      "Configuration",
      "Testing",
      "Deployment",
    ],
  },
  {
    id: "library",
    name: "Library",
    sections: [
      "Purpose",
      "Installation",
      "Usage",
      "API",
      "Compatibility",
      "Examples",
      "Contributing",
    ],
  },
  {
    id: "cli",
    name: "CLI",
    sections: [
      "Overview",
      "Installation",
      "Commands",
      "Flags and options",
      "Examples",
      "Configuration",
    ],
  },
  {
    id: "api",
    name: "API",
    sections: [
      "Overview",
      "Setup",
      "Authentication",
      "Endpoints",
      "Environment",
      "Sample requests and responses",
    ],
  },
  {
    id: "npm-package",
    name: "npm Package",
    sections: [
      "Purpose",
      "Installation",
      "Usage",
      "API",
      "Supported Node.js versions",
      "Examples",
      "Contributing",
    ],
  },
  {
    id: "rust-crate",
    name: "Rust Crate",
    sections: [
      "Purpose",
      "Installation",
      "Usage",
      "API",
      "Features",
      "Minimum Rust version",
      "Examples",
    ],
  },
  {
    id: "python-package",
    name: "Python Package",
    sections: [
      "Purpose",
      "Installation",
      "Usage",
      "API",
      "Supported Python versions",
      "Examples",
      "Testing",
    ],
  },
  {
    id: "game",
    name: "Game",
    sections: [
      "Overview",
      "Gameplay",
      "Controls",
      "How to run",
      "Screenshots",
      "Build instructions",
    ],
  },
  {
    id: "open-source",
    name: "Open Source",
    sections: [
      "Overview",
      "Setup",
      "Usage",
      "Contributing",
      "Support",
      "License",
    ],
  },
  {
    id: "tutorial",
    name: "Tutorial",
    sections: [
      "Learning objectives",
      "Prerequisites",
      "Setup",
      "Steps",
      "Expected results",
      "Further reading",
    ],
  },
  {
    id: "documentation",
    name: "Documentation",
    sections: [
      "Overview",
      "Getting started",
      "Navigation",
      "Reference",
      "Contributing",
    ],
  },
  {
    id: "generic",
    name: "Generic",
    sections: ["Overview", "Setup", "Usage", "Examples", "Support"],
  },
].map((template) => ({
  ...template,
  sections: projectTemplateSections[template.id] || template.sections,
}));

export function repositoryTemplateId(type) {
  if (type === "pwa") return "web-app";
  return repositoryTemplates.some((t) => t.id === type) ? type : "generic";
}

export function repositorySuggestions(repo = {}, type = "generic") {
  return {
    name: String(repo.name || ""),
    description: String(repo.description || ""),
    homepage: String(repo.homepage || ""),
    language: String(repo.language || ""),
    topics: Array.isArray(repo.topics) ? repo.topics.join(", ") : "",
    projectType: type,
    templateId: repositoryTemplateId(type),
  };
}

// Only reviewed values become content. Unknown instructions stay explicit prompts.
export function buildRepositoryTemplate({
  templateId,
  values,
  sections,
  existing = null,
  sourceContext = null,
  includeContext = true,
}) {
  const template = repositoryTemplates.find((t) => t.id === templateId);
  if (!template) throw Error("Choose a supported repository template.");
  const name = String(values.name || "").trim();
  if (!name) throw Error("Enter a repository name.");
  const homepage = String(values.homepage || "").trim();
  if (homepage && !/^https?:\/\//i.test(homepage))
    throw Error("Homepage must use HTTP or HTTPS.");
  if (homepage && !safeUrl(homepage, { relative: false }))
    throw Error("Enter a safe homepage URL.");
  const blocks = [];
  const add = (title, markdown) => {
    const block = createBlock("custom", { markdown });
    block.section = { title, kind: "repository" };
    if (sourceContext) block.sourceContext = structuredClone(sourceContext);
    blocks.push(block);
  };
  if (existing !== null) add("Existing README — preserved source", existing);
  const info = [
    existing === null ? `# ${text(name)}` : "## Reviewed repository context",
  ];
  if (values.description?.trim()) info.push(text(values.description.trim()));
  if (homepage) info.push(`<a href="${html(homepage)}">Project homepage</a>`);
  if (values.language?.trim())
    info.push(`Primary language: ${text(values.language.trim())}`);
  if (values.topics?.trim()) info.push(`Topics: ${text(values.topics.trim())}`);
  if (existing === null || includeContext)
    add("Repository overview", info.join("\n\n"));
  for (const section of template.sections) {
    if (sections.includes(section)) {
      const type = documentationType(section);
      if (type) {
        const block = createBlock(type, {
          ...documentationDefaults(type),
          title: section,
        });
        block.section = { title: section, kind: "documentation" };
        if (sourceContext) block.sourceContext = structuredClone(sourceContext);
        blocks.push(block);
      } else
        add(
          section,
          `## ${section}\n\n<!-- TODO: Write project-specific ${section.toLowerCase()} information. Remove this section if it does not apply. -->`,
        );
    }
  }
  return blocks;
}
