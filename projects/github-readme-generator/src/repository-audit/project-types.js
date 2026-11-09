// Stable IDs and deterministic, advisory profiles. No scores or required sections.
// `key` is the subset of `topics` the README Attention Queue and Improvement
// plans treat as key topics; the rest of the profile is optional context.
export const projectTypes = [
  {
    id: "web-app",
    name: "Web App",
    topics: [
      "overview",
      "visuals",
      "setup",
      "configuration",
      "testing",
      "deployment",
    ],
    key: ["overview", "visuals", "setup", "configuration"],
  },
  {
    id: "library",
    name: "Library",
    topics: [
      "overview",
      "installation",
      "usage",
      "api",
      "compatibility",
      "examples",
      "contributing",
    ],
    key: ["overview", "installation", "usage", "api", "examples"],
  },
  {
    id: "cli",
    name: "CLI",
    topics: [
      "installation",
      "commands",
      "options",
      "examples",
      "configuration",
    ],
    key: ["installation", "commands", "options", "examples"],
  },
  {
    id: "api",
    name: "API",
    topics: [
      "setup",
      "authentication",
      "endpoints",
      "configuration",
      "requests",
    ],
    key: ["setup", "authentication", "endpoints", "requests"],
  },
  {
    id: "npm-package",
    name: "npm Package",
    topics: [
      "overview",
      "installation",
      "usage",
      "api",
      "compatibility",
      "examples",
    ],
    key: ["overview", "installation", "usage", "api"],
  },
  {
    id: "rust-crate",
    name: "Rust Crate",
    topics: [
      "overview",
      "installation",
      "usage",
      "api",
      "compatibility",
      "examples",
    ],
    key: ["overview", "installation", "usage", "api"],
  },
  {
    id: "python-package",
    name: "Python Package",
    topics: [
      "overview",
      "installation",
      "usage",
      "api",
      "compatibility",
      "examples",
    ],
    key: ["overview", "installation", "usage", "api"],
  },
  {
    id: "game",
    name: "Game",
    topics: ["overview", "controls", "setup", "visuals", "gameplay", "build"],
    key: ["overview", "controls", "setup", "gameplay", "build"],
  },
  {
    id: "pwa",
    name: "PWA",
    topics: [
      "overview",
      "visuals",
      "setup",
      "configuration",
      "offline",
      "deployment",
    ],
    key: ["overview", "setup", "offline"],
  },
  {
    id: "documentation",
    name: "Documentation",
    topics: ["overview", "navigation", "examples", "contributing"],
    key: ["overview", "navigation"],
  },
  {
    id: "open-source",
    name: "Open Source Project",
    topics: ["overview", "setup", "usage", "contributing", "license"],
    key: ["overview", "setup", "usage", "contributing"],
  },
  {
    id: "tutorial",
    name: "Tutorial",
    topics: ["overview", "prerequisites", "steps", "examples"],
    key: ["overview", "prerequisites", "steps"],
  },
  {
    id: "experiment",
    name: "Experiment",
    topics: ["overview", "findings"],
    key: ["overview"],
  },
  {
    id: "generic",
    name: "Generic Repository",
    topics: ["overview", "setup", "usage", "links"],
    key: ["overview", "setup", "usage"],
  },
];

const definitions = {
  overview: [
    "Purpose / overview",
    /\b(?:overview|about|purpose|introduction)\b/i,
  ],
  visuals: ["Screenshot / demo", /\b(?:screenshots?|demo|preview)\b/i],
  setup: [
    "Setup / how to run",
    /\b(?:setup|set up|getting started|how to run|running)\b/i,
  ],
  installation: ["Installation", /\binstall(?:ation|ing)?\b/i],
  configuration: [
    "Environment / configuration",
    /\b(?:environment|configuration|configuring|settings)\b/i,
  ],
  testing: ["Testing", /\b(?:tests?|testing)\b/i],
  deployment: ["Deployment", /\b(?:deploy(?:ment|ing)?|hosting)\b/i],
  usage: ["Usage", /\b(?:usage|how to use|quick ?start)\b/i],
  api: ["API reference", /\b(?:api|reference)\b/i],
  compatibility: [
    "Compatibility",
    /\b(?:compatibility|supported versions?|requirements?|msrv|browser support)\b/i,
  ],
  examples: ["Examples", /\bexamples?\b/i],
  contributing: [
    "Contributing",
    /\b(?:contributing|contribution|development guide)\b/i,
  ],
  commands: ["Commands", /\b(?:commands?|usage)\b/i],
  options: ["Flags / options", /\b(?:flags?|options?|arguments?)\b/i],
  authentication: [
    "Authentication",
    /\b(?:authentication|authorization|auth|api keys?)\b/i,
  ],
  endpoints: ["Endpoints", /\b(?:endpoints?|routes?)\b/i],
  requests: ["Sample requests / responses", /\b(?:requests?|responses?)\b/i],
  controls: ["Controls", /\b(?:controls?|keyboard|key bindings)\b/i],
  gameplay: ["Gameplay", /\b(?:gameplay|how to play|rules)\b/i],
  build: ["Build instructions", /\b(?:build(?:ing)?|compil(?:e|ing|ation))\b/i],
  offline: [
    "Offline / installation behavior",
    /\b(?:offline|service worker|installable)\b/i,
  ],
  navigation: [
    "Documentation navigation",
    /\b(?:contents|navigation|guides?|index)\b/i,
  ],
  license: ["License", /\blicen[cs]e\b/i],
  prerequisites: [
    "Prerequisites",
    /\b(?:prerequisites?|requirements?|before you start)\b/i,
  ],
  steps: [
    "Learning steps",
    /\b(?:steps?|lessons?|walkthrough|getting started)\b/i,
  ],
  findings: [
    "Findings / limitations",
    /\b(?:findings|results?|limitations?|observations?|conclusions?)\b/i,
  ],
  links: ["Project / documentation links", /\b(?:links|resources)\b/i],
};

export const topicLabel = (key) => definitions[key]?.[0] || key;
// Whether a heading title uses any English topic term the audit looks for.
export const namesTopic = (title) =>
  Object.values(definitions).some(([, pattern]) => pattern.test(title));

// sectionHas only accepts populated sections outside comments/code examples.
export function documentationFacts(metrics, sectionHas) {
  const facts = Object.fromEntries(
    Object.entries(definitions).map(([id, [, pattern]]) => [
      id,
      sectionHas(pattern),
    ]),
  );
  facts.overview ||= metrics.substantiveParagraphs > 0;
  facts.setup ||= metrics.setup;
  facts.usage ||= metrics.usage;
  facts.examples ||= metrics.codeExamples > 0;
  facts.visuals ||= metrics.supportingImages > 0;
  facts.links ||= metrics.projectLinks > 0;
  return facts;
}

// Specific purposes take precedence over package ecosystems and general labels.
// Language/homepage alone never imply an application or a published package.
const signals = [
  [
    "pwa",
    ["pwa", "progressive-web-app"],
    /\bprogressive web app(?:lication)?\b/i,
  ],
  [
    "cli",
    ["cli", "command-line", "command-line-tool"],
    /\b(?:command[- ]line (?:tool|application|interface)|cli tool)\b/i,
  ],
  [
    "api",
    ["api", "rest-api", "graphql-api", "api-server"],
    /\b(?:rest(?:ful)? api|graphql api|api server)\b/i,
  ],
  [
    "game",
    ["game", "gamedev", "video-game"],
    /\b(?:video game|multiplayer game|single-player game|puzzle game)\b/i,
  ],
  [
    "npm-package",
    ["npm-package", "npm-module"],
    /\b(?:npm package|npm module)\b/i,
  ],
  [
    "rust-crate",
    ["rust-crate", "crate", "crates-io"],
    /\b(?:rust crate|published on crates\.io)\b/i,
  ],
  [
    "python-package",
    ["python-package", "pypi"],
    /\b(?:python package|published on pypi)\b/i,
  ],
  [
    "web-app",
    ["web-app", "webapp", "web-application", "website"],
    /\b(?:web app(?:lication)?|full[- ]stack application|website)\b/i,
  ],
  [
    "library",
    ["library", "sdk"],
    /\b(?:library for|sdk for|reusable library)\b/i,
  ],
  [
    "documentation",
    ["documentation", "docs"],
    /\b(?:documentation site|documentation repository)\b/i,
  ],
  [
    "tutorial",
    ["tutorial", "course", "learning-resource"],
    /\b(?:tutorial|step-by-step lesson)\b/i,
  ],
  [
    "experiment",
    ["experiment", "experimental", "proof-of-concept", "prototype"],
    /\b(?:experiment|proof of concept|experimental prototype)\b/i,
  ],
  ["open-source", ["open-source", "opensource"], /\bopen[- ]source project\b/i],
];

export function suggestProjectType(repo = {}, prose = "") {
  const topics = new Set(
    (Array.isArray(repo.topics) ? repo.topics : [])
      .filter((v) => typeof v === "string")
      .slice(0, 100)
      .map((v) => v.toLowerCase()),
  );
  const name = typeof repo.name === "string" ? repo.name.toLowerCase() : "";
  const topicCandidates = [],
    proseCandidates = [],
    nameCandidates = [];
  for (const [id, aliases, pattern] of signals) {
    const topic = aliases.find((v) => topics.has(v));
    const nameHint = aliases.find(
      (v) => name === v || name.startsWith(`${v}-`) || name.endsWith(`-${v}`),
    );
    if (topic)
      topicCandidates.push({
        id,
        reason: `Repository topic “${topic}”.`,
        source: "topic",
        match: topic,
      });
    else if (pattern.test(prose)) {
      const match = prose.match(pattern)[0];
      proseCandidates.push({
        id,
        reason: `README prose includes “${match}”.`,
        source: "prose",
        match,
      });
    } else if (nameHint)
      nameCandidates.push({
        id,
        reason: `Repository name contains “${nameHint}”; this is a weak hint.`,
        source: "name",
        match: nameHint,
      });
  }
  const candidates = [
    ...topicCandidates,
    ...proseCandidates,
    ...nameCandidates,
  ];
  const chosen = candidates[0] || {
    id: "generic",
    reason:
      "No specific project-type evidence found. Language and homepage alone do not establish a project type.",
    source: "fallback",
    match: "",
  };
  return { ...chosen, alternatives: candidates.slice(1).map((c) => c.id) };
}

export function assessProjectType(result, override = "auto") {
  const suggestion = result.suggestion || {
    id: "generic",
    reason: "No specific project-type evidence found.",
    alternatives: [],
  };
  const id = override === "auto" ? suggestion.id : override;
  const type = projectTypes.find((t) => t.id === id);
  if (!type) throw Error("Choose a supported project type.");
  const facts = result.documentation || {};
  const detected = type.topics.filter((key) => facts[key]);
  const missing = type.topics.filter((key) => !facts[key]);
  const m = result.metrics;
  let state = result.state;
  if (m && id !== "generic") {
    state =
      !m.substantiveParagraphs || m.meaningfulWords < 20 ? "stub" : "minimal";
    if (id === "experiment" && m.substantiveParagraphs > 0 && facts.overview)
      state = "basic";
    else if (
      m.meaningfulWords >= 40 &&
      m.substantiveParagraphs &&
      detected.length >= 2
    )
      state = "basic";
    if (
      m.meaningfulWords >= 250 &&
      m.substantiveParagraphs >= 3 &&
      m.headings >= 3 &&
      detected.length >= Math.min(4, type.topics.length) &&
      (m.codeExamples || m.supportingImages || m.projectLinks)
    )
      state = "detailed";
    if (
      state === "detailed" &&
      m.meaningfulWords >= 1200 &&
      m.headings >= 8 &&
      m.substantiveParagraphs >= 6 &&
      (m.codeExamples >= 4 || m.projectLinks >= 4 || m.supportingImages >= 4)
    )
      state = "documentation-heavy";
  }
  const labels = {
    missing: "Missing README",
    stub: "Stub README",
    minimal: "Minimal",
    basic: "Basic",
    detailed: "Detailed",
    "documentation-heavy": "Documentation-heavy",
  };
  const article = ["api", "npm-package", "open-source", "experiment"].includes(
    id,
  )
    ? "an"
    : "a";
  const evidence = m
    ? [
        `${m.meaningfulWords} meaningful prose words · ${m.characters} source characters`,
        `${m.headings} headings · ${m.substantiveParagraphs} substantive prose passages`,
        `${m.images} images (${m.badges} badges) · ${m.codeExamples} code examples · ${m.projectLinks} project/documentation links`,
        ...detected.map((key) => `${definitions[key][0]}: evidence detected.`),
        ...missing.map(
          (key) =>
            `${definitions[key][0]}: not detected. Commonly useful for this project type.`,
        ),
        ...(id === "experiment"
          ? [
              "A short README may be entirely appropriate for an experiment; findings are optional context.",
            ]
          : []),
        ...(["stub", "minimal"].includes(state)
          ? ["README needs attention; review the evidence in context."]
          : []),
      ]
    : result.evidence;
  return {
    state,
    label: `${labels[state]} for ${id === "documentation" ? "Documentation" : `${article} ${type.name}`}`,
    type,
    suggestion,
    evidence,
    detected,
    missing,
  };
}
