const types = {
  profile: {
    label: "Profile",
    tasks: [
      [
        "identity",
        "Introduce yourself",
        ["about", "hello", "hi"],
        "Help a visitor understand who you are and what you work on.",
      ],
      [
        "work",
        "Show selected work",
        ["projects", "work"],
        "A small, verified selection is easier to scan than an unbounded list.",
      ],
      [
        "contact",
        "Offer a contact route",
        ["contact", "connect"],
        "Meaningful contact labels help people choose the right route.",
      ],
    ],
  },
  cli: {
    label: "CLI",
    tasks: [
      [
        "install",
        "Explain installation",
        ["install", "installation", "setup"],
        "Readers need a verified path to obtain the command.",
      ],
      [
        "usage",
        "Show one minimal command",
        ["usage", "quick start", "example"],
        "A smallest useful command makes the interface concrete.",
      ],
      [
        "options",
        "Describe important options",
        ["options", "commands", "reference"],
        "Focused option guidance is more useful than an unexplained dump.",
      ],
    ],
  },
  library: {
    label: "Library",
    tasks: [
      [
        "install",
        "Explain installation",
        ["install", "installation", "setup"],
        "Name the package and supported package manager commands.",
      ],
      [
        "usage",
        "Show a minimal import and use",
        ["usage", "quick start", "example"],
        "A verified first call connects installation to an outcome.",
      ],
      [
        "api",
        "Point to API details",
        ["api", "reference"],
        "Readers need to know which surface is stable and where details live.",
      ],
    ],
  },
  api: {
    label: "API",
    tasks: [
      [
        "auth",
        "Explain authentication",
        ["authentication", "authorization", "auth"],
        "State the verified credential shape without including a real secret.",
      ],
      [
        "request",
        "Show one minimal request",
        ["quick start", "request", "example", "usage"],
        "A smallest request clarifies the endpoint and response contract.",
      ],
      [
        "errors",
        "Describe common errors",
        ["errors", "troubleshooting"],
        "Named failure cases help callers distinguish retryable and permanent errors.",
      ],
    ],
  },
  game: {
    label: "Game",
    tasks: [
      [
        "play",
        "Explain how to play",
        ["how to play", "gameplay", "quick start"],
        "Players need the objective before implementation detail.",
      ],
      [
        "controls",
        "List controls",
        ["controls", "input"],
        "Action-oriented controls reduce first-play uncertainty.",
      ],
      [
        "run",
        "Explain local setup",
        ["install", "installation", "run", "setup"],
        "Verified local steps help contributors reproduce the game.",
      ],
    ],
  },
};

const examples = {
  setup: {
    label: "Make setup actionable",
    before: "## Setup\n\nInstall the project and configure it.",
    after:
      "## Setup\n\n1. Install dependencies with `[verified command]`.\n2. Copy `[verified example file]` to `[verified destination]`.\n3. Run `[verified check]`.",
    annotations: [
      "Turns a vague instruction into an ordered task.",
      "Placeholders visibly require project evidence; they are not invented facts.",
      "Ends with a verification step so success is observable.",
    ],
  },
  usage: {
    label: "Lead with a smallest useful example",
    before:
      "## Usage\n\nThis project is easy to use and supports many options.",
    after:
      "## Usage\n\n```text\n[smallest verified example]\n```\n\nExpected result: `[verified observable result]`.",
    annotations: [
      "Replaces an unsupported quality claim with an observable task.",
      "Keeps the example deliberately synthetic until the author verifies it.",
      "Names the result readers should check.",
    ],
  },
  troubleshooting: {
    label: "Explain a failure precisely",
    before: "## Troubleshooting\n\nIf it fails, try again.",
    after:
      "## Troubleshooting\n\n### `[observed error]`\n\nCause: `[verified cause or Unknown]`\n\nNext check: `[safe diagnostic step]`",
    annotations: [
      "Names the evidence a reader can match.",
      "Allows Unknown instead of fabricating a cause.",
      "Suggests diagnosis rather than an unbounded retry.",
    ],
  },
};

const headingLines = (source) =>
  sourceTokens(String(source))
    .filter(({ token }) => token.type === "heading")
    .map(({ token, start }) => ({
      text: token.text,
      normalized: normalizeHeading(token.text),
      index:
        String(source)
          .slice(0, start)
          .split(/\r\n?|\n/).length - 1,
    }));

const containsPhrase = (heading, phrase) =>
  ` ${heading} `.includes(` ${normalizeHeading(phrase)} `);

export const projectTypes = () =>
  Object.entries(types).map(([id, value]) => ({ id, label: value.label }));

export function lessonReview(source, type) {
  const definition = types[type];
  if (!definition) throw new Error("Choose a supported project type.");
  const headings = headingLines(source);
  return {
    type,
    label: definition.label,
    tasks: definition.tasks.map(([id, label, aliases, why]) => {
      const matches = headings.filter((heading) =>
        aliases.some((alias) => containsPhrase(heading.normalized, alias)),
      );
      return {
        id,
        label,
        why,
        status:
          matches.length === 1
            ? "observed"
            : matches.length > 1
              ? "unknown"
              : "not-detected",
        evidence:
          matches.length === 1
            ? `Observed heading “${matches[0].text}”. Content accuracy is still Unknown.`
            : matches.length > 1
              ? `Multiple possible headings (${matches.map((m) => `“${m.text}”`).join(", ")}); choose the intended section in the editor.`
              : "No matching heading detected. This may be intentionally covered elsewhere.",
        line: matches.length === 1 ? matches[0].index : null,
      };
    }),
    caveat:
      "Lessons inspect headings only. Commands, links, claims and runtime behavior remain Unknown until you verify them.",
  };
}

export function writingExamples() {
  return Object.entries(examples).map(([id, value]) => ({ id, ...value }));
}
export function checklist(type) {
  const lesson = types[type];
  if (!lesson) throw new Error("Choose a supported project type.");
  return lesson.tasks.map(([id, label, , why]) => ({ id, label, why }));
}
export function lineRange(source, line) {
  const value = String(source);
  if (!Number.isSafeInteger(line) || line < 0)
    return { start: value.length, end: value.length };
  let current = 0,
    start = 0;
  for (const match of value.matchAll(/\r\n?|\n/g)) {
    if (current === line) return { start, end: match.index };
    current += 1;
    start = match.index + match[0].length;
  }
  return current === line
    ? { start, end: value.length }
    : { start: value.length, end: value.length };
}
export function checklistMarkdown(type, completed = []) {
  const definition = types[type];
  if (!definition) throw new Error("Choose a supported project type.");
  const done = new Set(completed);
  return `# ${definition.label} README checklist\n\n${definition.tasks.map(([id, label]) => `- [${done.has(id) ? "x" : " "}] ${label}`).join("\n")}\n\n> Advisory checklist exported by README Studio. Verify every project-specific fact.\n`;
}
import { normalizeHeading, sourceTokens } from "../markdown/sections.js";
