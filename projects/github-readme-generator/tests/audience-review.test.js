import { describe, expect, it } from "vitest";
import {
  audienceReview,
  firstVisitChecklist,
  planSectionOrder,
} from "../src/audience/review.js";

describe("audience-specific review", () => {
  const source = `# Acme CLI

Formats files locally.

## Installation

Install the verified binary.

## Usage

Run acme with a path.

## Contributing

Run the tests before opening a change.
`;

  it.each(["user", "recruiter", "contributor", "maintainer"])(
    "returns evidence, caveats and no fake score for %s",
    (persona) => {
      const result = audienceReview(source, persona);
      expect(result.persona).toBe(persona);
      expect(result.checks.length).toBeGreaterThan(2);
      expect(result.checks.every((check) => check.evidence)).toBe(true);
      expect(result.caveat).toMatch(/advisory|not proof/i);
      expect(result).not.toHaveProperty("score");
      expect(JSON.stringify(result)).not.toMatch(/percent|\b\d+\/\d+\b/i);
    },
  );

  it("uses unknown for an unrecognized structure rather than claiming details are absent", () => {
    const result = audienceReview(
      "Proyecto local sin encabezados reconocibles.",
      "user",
    );
    expect(result.confidence).toBe("uncertain");
    expect(result.checks.every((check) => check.status === "unknown")).toBe(
      true,
    );
    expect(result.checks[0].evidence).toMatch(/could not determine/i);
  });
});

describe("section order proposals", () => {
  it("reorders exact H2 source slices behind the untouched preamble", () => {
    const source = `# Tool\r\n\r\nIntro.  \r\n\r\n## Contributing\r\n\r\nHelp.\r\n\r\n## Installation\r\n\r\nInstall.\r\n\r\n## Usage\r\n\r\nUse.\r\n`;
    const plan = planSectionOrder(source, "user");
    expect(plan.safe).toBe(true);
    expect(plan.changed).toBe(true);
    expect(plan.markdown).toBe(
      `# Tool\r\n\r\nIntro.  \r\n\r\n## Installation\r\n\r\nInstall.\r\n\r\n## Usage\r\n\r\nUse.\r\n## Contributing\r\n\r\nHelp.\r\n\r\n`,
    );
    expect(
      plan.markdown.replace(/## (Installation|Usage|Contributing)\r\n/g, ""),
    ).toContain("Intro.  ");
  });

  it("refuses ambiguous hierarchy instead of guessing", () => {
    for (const source of [
      "# One\n\n## Usage\nA\n\n# Two\n\n## Install\nB\n",
      "## Usage\n\nRun.\n\n# Tool\n\nIntro.\n\n## Installation\n\nInstall.\n",
      "# One\n\n## Usage\nA\n\n## Usage\nB\n",
      "No headings here",
    ]) {
      const plan = planSectionOrder(source, "user");
      expect(plan.safe).toBe(false);
      expect(plan.markdown).toBe(source);
      expect(plan.reason).toMatch(/ambiguous|heading|detected/i);
    }
  });
});

describe("first-visit checklist", () => {
  const fixtures = {
    game: "# Game\n\n## Controls\n\nUse arrows.\n\n## Gameplay\n\nReach the exit.\n\n## Privacy\n\nSaves stay local.\n",
    cli: "# CLI\n\n## Installation\n\nInstall it.\n\n## Commands\n\n`tool run`\n\n## Examples\n\n`tool run file`\n",
    library:
      "# Library\n\n## Installation\n\nInstall it.\n\n## Requirements\n\nNode 22.\n\n## Examples\n\n```js\nuse()\n```\n",
    api: "# API\n\n## Authentication\n\nUse a test token.\n\n## Endpoints\n\nGET /items\n\n## Examples\n\nGET /items -> []\n",
  };

  const expectedStatuses = {
    game: {
      start: "not-detected",
      controls: "observed",
      gameplay: "observed",
      data: "observed",
      verified: "unknown",
    },
    cli: {
      install: "observed",
      usage: "observed",
      commands: "observed",
      examples: "observed",
      verified: "unknown",
    },
    library: {
      install: "observed",
      usage: "observed",
      compatibility: "observed",
      examples: "observed",
      verified: "unknown",
    },
    api: {
      start: "not-detected",
      auth: "observed",
      endpoints: "observed",
      requests: "observed",
      verified: "unknown",
    },
  };

  it.each(Object.entries(fixtures))(
    "reports observed, not-detected and unknown evidence for %s",
    (type, markdown) => {
      const result = firstVisitChecklist(markdown, type);
      expect(result.projectType).toBe(type);
      expect(
        Object.fromEntries(result.items.map(({ id, status }) => [id, status])),
      ).toEqual(expectedStatuses[type]);
      expect(
        result.items.find((item) => item.status === "unknown").evidence,
      ).toMatch(/cannot verify/i);
    },
  );

  it("rejects unsupported project types and leaves source untouched", () => {
    expect(() => firstVisitChecklist("# X", "web-app")).toThrow(/game, cli/i);
    const source = fixtures.api;
    firstVisitChecklist(source, "api");
    expect(source).toBe(fixtures.api);
  });
});
