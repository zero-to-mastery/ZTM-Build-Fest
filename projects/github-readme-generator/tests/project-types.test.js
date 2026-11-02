import { describe, expect, it } from "vitest";
import { classifyReadme } from "../src/repository-audit/classify.js";
import {
  assessProjectType,
  projectTypes,
  suggestProjectType,
} from "../src/repository-audit/project-types.js";

const overview =
  "This small project explores local data storage with a reproducible comparison of different approaches and explains the practical tradeoffs observed during development.";
const section = (name) =>
  `\n\n## ${name}\n\nFollow these documented steps to reproduce the behavior locally and adapt the example to your own environment.\n`;
const assess = (source, type) =>
  assessProjectType(classifyReadme(source), type);

describe("explainable project-type suggestions", () => {
  it.each([
    ["web-app", "web-app"],
    ["library", "library"],
    ["cli", "cli"],
    ["api", "rest-api"],
    ["npm-package", "npm-package"],
    ["rust-crate", "rust-crate"],
    ["python-package", "pypi"],
    ["game", "game"],
    ["pwa", "pwa"],
    ["documentation", "documentation"],
    ["open-source", "open-source"],
    ["tutorial", "tutorial"],
    ["experiment", "experiment"],
  ])("suggests %s from public topic %s", (id, topic) => {
    const suggestion = suggestProjectType({ topics: [topic] });
    expect(suggestion.id).toBe(id);
    expect(suggestion.reason).toContain(topic);
    expect(suggestProjectType({ topics: [topic] })).toEqual(suggestion);
    expect(suggestion).not.toHaveProperty("score");
    expect(suggestion).not.toHaveProperty("confidence");
  });

  it("does not infer publishing or a web app from language/homepage alone", () => {
    for (const language of ["Rust", "Python", "JavaScript", "TypeScript"]) {
      expect(
        suggestProjectType({ language, homepage: "https://example.org" }).id,
      ).toBe("generic");
    }
    expect(suggestProjectType().reason).toContain("No specific");
    expect(suggestProjectType({ topics: ["api"] }).id).toBe("api");
    expect(projectTypes).toHaveLength(14);
    expect(new Set(projectTypes.map((t) => t.id)).size).toBe(14);
  });

  it("explains ambiguous signals in stable order and favors topics over weak names", () => {
    const suggestion = suggestProjectType({
      name: "sample-cli",
      topics: ["game", "web-app"],
    });
    expect(suggestion.id).toBe("game");
    expect(suggestion.alternatives).toEqual(["web-app", "cli"]);
    expect(suggestProjectType({ topics: ["npm-package", "cli"] }).id).toBe(
      "cli",
    );
    expect(suggestProjectType({ name: "sample-cli" }).reason).toContain(
      "weak hint",
    );
    expect(suggestProjectType({ name: "clinical" }).id).toBe("generic");
  });

  it("uses substantive README prose, excluding code, comments, badges and heading examples", () => {
    const text = `${overview} This command-line tool inspects local files.\n`;
    expect(classifyReadme(text).suggestion.id).toBe("cli");
    expect(classifyReadme(text).suggestion.reason).toContain(
      "command-line tool",
    );
    expect(
      classifyReadme(
        "<!-- a command-line tool -->\n\n```md\nThis is a Rust crate.\n## Installation\n```\n\n![npm package](https://img.shields.io/badge/npm-package-red)\n\n# Web application",
      ).suggestion.id,
    ).toBe("generic");
    expect(
      classifyReadme(
        "<script>command-line tool</script>\n\n<pre>python package</pre>",
      ).suggestion.id,
    ).toBe("generic");
  });
});

describe("type-specific documentation expectations", () => {
  it("changes expectations and classification for the same short experiment", () => {
    const result = classifyReadme(overview, { topics: ["experiment"] });
    const experiment = assessProjectType(result);
    const web = assessProjectType(result, "web-app");
    expect(experiment.label).toBe("Basic for an Experiment");
    expect(experiment.evidence.join(" ")).toContain(
      "short README may be entirely appropriate",
    );
    expect(experiment.missing).not.toContain("deployment");
    expect(web.label).toBe("Minimal for a Web App");
    expect(web.missing).toContain("deployment");
    expect(web.evidence.join(" ")).toContain(
      "Commonly useful for this project type.",
    );
    expect(
      assess(
        "This experiment compares local caching strategies and records the observed behavior across different storage engines.",
        "experiment",
      ).state,
    ).toBe("basic");
    expect(result.suggestion.id).toBe("experiment");
    expect(assessProjectType(result)).toEqual(experiment);
  });

  it.each(projectTypes.map((type) => [type.id, type.topics]))(
    "has deterministic expectations for %s",
    (id, topics) => {
      const a = assess(overview, id);
      expect([...a.detected, ...a.missing].sort()).toEqual([...topics].sort());
      expect(a).toEqual(assess(overview, id));
      expect(a).not.toHaveProperty("score");
      for (const evidence of a.evidence.filter((v) =>
        v.includes("not detected"),
      ))
        expect(evidence).toContain("Commonly useful for this project type.");
    },
  );

  it("distinguishes CLI, API and game information instead of universal setup demands", () => {
    const cli = assess(
      overview + section("Commands") + section("Flags and options"),
      "cli",
    );
    expect(cli.detected).toEqual(["commands", "options"]);
    expect(cli.state).toBe("basic");
    const api = assess(
      overview +
        section("Authentication") +
        section("Endpoints") +
        section("Sample requests and responses"),
      "api",
    );
    expect(api.detected).toEqual(["authentication", "endpoints", "requests"]);
    const game = assess(
      overview +
        section("Controls") +
        section("Gameplay") +
        section("Build instructions"),
      "game",
    );
    expect(game.detected).toEqual([
      "overview",
      "controls",
      "gameplay",
      "build",
    ]);
    expect(game.missing).not.toContain("authentication");
  });

  it("accepts detailed documentation without universal installation/usage headings", () => {
    const text =
      overview +
      ["Overview", "Navigation", "Examples", "Contributing"]
        .map((name) => section(name) + overview.repeat(3))
        .join("") +
      "\n\n[Guide](https://example.org/guide)";
    const result = assess(text, "documentation");
    expect(result.state).toBe("detailed");
    expect(result.missing).toEqual([]);
  });

  it("does not mistake empty headings, comments or example headings for populated sections", () => {
    const text =
      overview +
      "\n\n## Authentication\n\n## Endpoints\n<!-- sample requests instructions should not count as actual documentation -->\n\n```md\n## Configuration\nSome example documentation with enough words to look substantial.\n```";
    const result = assess(text, "api");
    expect(result.detected).not.toContain("authentication");
    expect(result.detected).not.toContain("configuration");
    // The code block under Endpoints is real supporting content for that section.
    expect(result.detected).toContain("endpoints");
  });

  it("keeps missing, tiny, code-only and badge-only READMEs distinct from substantive experiments", () => {
    for (const type of projectTypes) {
      expect(assess(null, type.id).state).toBe("missing");
      for (const source of [
        "# TODO",
        "```js\nconsole.log('hi')\n```",
        "# Overview\n\n```js\nconsole.log('hi')\n```",
        "# Overview\n\nThis small experiment checks three simple cases.",
        "![Build](https://img.shields.io/badge/build-passing-green)",
      ])
        expect(assess(source, type.id).state).toBe("stub");
    }
  });

  it("preserves exact source and rejects unknown manual overrides", () => {
    const source = "\ufeff# Café\r\n\r\n" + overview;
    const result = classifyReadme(source, { topics: ["cli"] });
    const before = JSON.stringify(result);
    for (const type of projectTypes) assessProjectType(result, type.id);
    expect(JSON.stringify(result)).toBe(before);
    expect(result.metrics.characters).toBe(source.length);
    expect(() => assessProjectType(result, "<script>")).toThrow(
      "supported project type",
    );
  });
});
