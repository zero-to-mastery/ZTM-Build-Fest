import {
  detectSections,
  normalizeHeading,
  sourceTokens,
} from "../markdown/sections.js";

const roles = {
  overview: /^(?:overview|about|introduction|what|why|features?)\b/i,
  installation:
    /\b(?:install(?:ation)?|setup|getting started|requirements?)\b/i,
  usage: /\b(?:usage|quick ?start|how to use|examples?)\b/i,
  help: /\b(?:support|troubleshooting|faq|help)\b/i,
  outcomes: /\b(?:results?|impact|highlights?|projects?|case stud)/i,
  role: /\b(?:role|contribution|built by|team)\b/i,
  contact: /\b(?:contact|links?|website|demo)\b/i,
  contributing: /\b(?:contribut(?:ing|ion)|development)\b/i,
  testing: /\b(?:tests?|testing|quality)\b/i,
  architecture: /\b(?:architecture|design|internals?)\b/i,
  status: /\b(?:status|roadmap|maintenance|support)\b/i,
  operations: /\b(?:deploy|operations?|release|monitoring)\b/i,
  security: /\b(?:security|vulnerabilit|privacy)\b/i,
  releases: /\b(?:releases?|changelog|versioning)\b/i,
  controls: /\b(?:controls?|key bindings?|keyboard)\b/i,
  gameplay: /\b(?:gameplay|how to play|rules)\b/i,
  commands: /\b(?:commands?|options?|flags?|arguments?)\b/i,
  compatibility: /\b(?:compatibility|supported versions?|requirements?)\b/i,
  authentication: /\b(?:authentication|authorization|auth)\b/i,
  endpoints: /\b(?:endpoints?|routes?|api reference)\b/i,
  requests: /\b(?:requests?|responses?|examples?)\b/i,
  data: /\b(?:save|data behavior|storage|backup|privacy)\b/i,
};

const personas = {
  user: {
    label: "End user",
    order: ["overview", "installation", "usage", "help"],
    checks: [
      ["purpose", "Purpose and scope", "overview"],
      ["start", "Verified way to start", "installation"],
      ["use", "Usage or example", "usage"],
      ["help", "Help when something goes wrong", "help"],
    ],
  },
  recruiter: {
    label: "Recruiter",
    order: ["overview", "outcomes", "role", "contact"],
    checks: [
      ["purpose", "Project purpose", "overview"],
      ["outcomes", "Outcomes or impact", "outcomes"],
      ["role", "Author role or contribution", "role"],
      ["contact", "Demo, project, or contact path", "contact"],
    ],
  },
  contributor: {
    label: "Contributor",
    order: ["overview", "installation", "contributing", "testing"],
    checks: [
      ["setup", "Development prerequisites and setup", "installation"],
      ["contributing", "Contribution workflow", "contributing"],
      ["testing", "Test or verification command", "testing"],
      ["architecture", "Architecture or code orientation", "architecture"],
    ],
  },
  maintainer: {
    label: "Maintainer",
    order: ["overview", "status", "operations", "security", "releases"],
    checks: [
      ["status", "Maintenance status and support boundary", "status"],
      ["operations", "Deployment or operations", "operations"],
      ["security", "Security reporting or privacy", "security"],
      ["releases", "Release or versioning process", "releases"],
    ],
  },
};

function personaDefinition(persona) {
  const definition = personas[persona];
  if (!definition)
    throw Error("Choose user, recruiter, contributor or maintainer.");
  return definition;
}

function populated(section) {
  return /[\p{L}\p{N}]{3}/u.test(section.body.replace(/<!--[\s\S]*?-->/g, ""));
}

function rolesFor(title) {
  const normalized = normalizeHeading(title);
  return Object.entries(roles)
    .filter(([, pattern]) => pattern.test(normalized))
    .map(([role]) => role);
}

function roleFor(title, preferred = []) {
  const matches = rolesFor(title);
  return preferred.find((role) => matches.includes(role)) || matches[0];
}

function observedSections(markdown) {
  return detectSections(markdown).filter(
    (section) => section.level > 0 && populated(section),
  );
}

export function audienceReview(markdown, persona) {
  const definition = personaDefinition(persona);
  const sections = observedSections(String(markdown));
  const recognized = sections.filter(
    (section) => rolesFor(section.title).length,
  );
  const uncertain = recognized.length === 0;
  return {
    persona,
    label: definition.label,
    confidence: uncertain ? "uncertain" : "heading-evidence",
    caveat:
      "Advisory heading evidence is not proof that a topic is complete, correct, or required.",
    checks: definition.checks.map(([id, label, role]) => {
      if (uncertain)
        return {
          id,
          label,
          status: "unknown",
          evidence:
            "The analyzer could not determine this topic from populated, recognized headings.",
        };
      const match = sections.find((section) =>
        rolesFor(section.title).includes(role),
      );
      return match
        ? {
            id,
            label,
            status: "observed",
            evidence: `Populated heading “${match.title}” was observed.`,
          }
        : {
            id,
            label,
            status: "not-detected",
            evidence:
              "Not detected in a populated recognized heading; it may be described elsewhere or use different language.",
          };
    }),
  };
}

export function planSectionOrder(markdown, persona) {
  const source = String(markdown);
  const definition = personaDefinition(persona);
  const headings = sourceTokens(source).filter(
    ({ token }) => token.type === "heading",
  );
  const h1s = headings.filter(({ token }) => token.depth === 1);
  const firstH2 = headings.find(({ token }) => token.depth === 2);
  const sections = detectSections(source, { levels: [2] });
  const preamble = sections[0]?.level === 0 ? sections[0] : null;
  const h2s = sections.filter((section) => section.level === 2);
  const names = h2s.map((section) => normalizeHeading(section.title));
  const sectionRoles = h2s.map((section) =>
    roleFor(section.title, definition.order),
  );
  if (
    h1s.length > 1 ||
    h1s.some(({ start }) => firstH2 && start > firstH2.start) ||
    h2s.length < 2 ||
    new Set(names).size !== names.length ||
    sectionRoles.filter(Boolean).length < 2 ||
    new Set(sectionRoles.filter(Boolean)).size !==
      sectionRoles.filter(Boolean).length
  )
    return {
      safe: false,
      changed: false,
      markdown: source,
      reason:
        "A safe order was not detected: the heading hierarchy is missing, repeated, or ambiguous.",
    };
  const rank = (role) => {
    const at = definition.order.indexOf(role);
    return at < 0 ? definition.order.length : at;
  };
  const ordered = h2s
    .map((section, index) => ({ section, index, role: sectionRoles[index] }))
    .sort((a, b) => rank(a.role) - rank(b.role) || a.index - b.index)
    .map(({ section }) => section);
  const result = `${preamble?.source || ""}${ordered.map((section) => section.source).join("")}`;
  return {
    safe: true,
    changed: result !== source,
    markdown: result,
    reason:
      result === source
        ? "Recognized sections already follow the selected audience path."
        : "Recognized H2 sections can be reordered as exact source slices after review.",
    headings: ordered.map((section) => section.title),
  };
}

const visitTypes = {
  game: [
    ["start", "How to start the game", "installation"],
    ["controls", "Controls and input", "controls"],
    ["gameplay", "Goal, rules, or gameplay", "gameplay"],
    ["data", "Save or data behavior", "data"],
  ],
  cli: [
    ["install", "Installation and prerequisites", "installation"],
    ["usage", "First command or usage", "usage"],
    ["commands", "Commands, flags, or options", "commands"],
    ["examples", "Worked example", "requests"],
  ],
  library: [
    ["install", "Installation and prerequisites", "installation"],
    ["usage", "Minimal usage", "usage"],
    ["compatibility", "Supported versions or compatibility", "compatibility"],
    ["examples", "Worked example", "requests"],
  ],
  api: [
    ["start", "Prerequisites or base setup", "installation"],
    ["auth", "Authentication applicability", "authentication"],
    ["endpoints", "Endpoint or API reference", "endpoints"],
    ["requests", "Sample request and response", "requests"],
  ],
};

export function firstVisitChecklist(markdown, projectType) {
  const expected = visitTypes[projectType];
  if (!expected)
    throw Error("Choose a supported project type: game, cli, library or api.");
  const sections = observedSections(String(markdown));
  const recognized = sections.filter(
    (section) => rolesFor(section.title).length,
  );
  const uncertain = recognized.length === 0;
  const items = expected.map(([id, label, role]) => {
    const match = sections.find((section) =>
      rolesFor(section.title).includes(role),
    );
    if (match)
      return {
        id,
        label,
        status: "observed",
        evidence: `Populated heading “${match.title}” was observed.`,
      };
    return {
      id,
      label,
      status: uncertain ? "unknown" : "not-detected",
      evidence: uncertain
        ? "The README structure could not be interpreted confidently."
        : "Not detected in the README; it may exist elsewhere or use different language.",
    };
  });
  items.push({
    id: "verified",
    label: "Steps work for a first-time reader",
    status: "unknown",
    evidence:
      "Static README analysis cannot verify commands, prerequisites, services, credentials, or runtime results.",
  });
  return {
    projectType,
    caveat:
      "Observed means text was found, not that the instructions are accurate. Not detected never means absent from the project.",
    items,
  };
}
