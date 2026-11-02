import { randomizeV6, temporalEligibility } from "./design-randomizer-v6.mjs";
import { seededRandom } from "./seeded-random.mjs";
import { presetOptions } from "./studio-presets.mjs";
import { parseConfig, CONFIG_VERSION } from "./config-schema.mjs";
import { validateIntent, choicesFor } from "./onboarding-model.mjs";

// Intent is compiled here; neither the renderer nor exported Scene JSON knows about the wizard.
export function generateGuidedDesign(
  account,
  repositories,
  answers,
  { seed, year, activityAvailable = true } = {},
) {
  const intent = validateIntent(answers),
    random = seededRandom(`guided:${seed}`);
  const { selected } = choicesFor(repositories, intent.projects, year);
  if (selected.length !== intent.projects.length)
    throw Error(
      "Some selected projects are unavailable. Edit your project selection.",
    );
  // Persist and render GitHub's canonical spelling so later exact-match
  // filters and showcase metadata refer to the same repositories.
  intent.projects = selected.map((repo) => repo.full_name);
  if (intent.projectShowcase) {
    const canonicalNames = new Map(
      selected.map((repo) => [repo.full_name.toLowerCase(), repo.full_name]),
    );
    intent.projectShowcase = Object.fromEntries(
      Object.entries(intent.projectShowcase).map(([name, role]) => [
        canonicalNames.get(name.toLowerCase()) || name,
        role,
      ]),
    );
  }
  const span = temporalEligibility(selected, [], year);
  const code = `v6:m${intent.motion === "still" ? "000" : "7ff"}-y${year}-f${span.firstYear}-e${Number(span.eligible)}-${seed}`;
  let options = randomizeV6(code, { repositories: selected });
  const history = ["rings", "galaxy", "dimension"].includes(intent.history)
    ? intent.history
    : span.eligible
      ? intent.history === "surprise"
        ? random() < 0.4
          ? "3d"
          : random() < 0.5
            ? "history"
            : "current"
        : intent.history
      : "current";
  if (history === "3d") {
    // Reuse the v6 temporal recipe rather than creating another geometry randomizer.
    for (
      let attempt = 0;
      options.arrangement !== "temporal-stack" && attempt < 100;
      attempt++
    )
      options = randomizeV6(`${code}-${attempt}`, { repositories: selected });
  } else {
    options.arrangement = ["rings", "galaxy"].includes(history)
      ? history
      : history === "history"
        ? "era-rings"
        : ["rings", "galaxy", "solar-system", "field"][
            Math.floor(random() * 4)
          ];
    options.temporalStack = { enabled: false };
  }
  if (history === "dimension") {
    options.arrangement = "temporal-stack";
    options.temporalStack = {
      enabled: true,
      axis: intent.dimension,
      innerArrangement: "rings",
    };
  }
  if (intent.topology !== "later") {
    options.profileEmphasis = intent.topology;
    if (options.arrangement === "temporal-stack")
      options.temporalStack = {
        ...options.temporalStack,
        innerArrangement: "profile",
      };
    else options.arrangement = "profile";
  }
  const motion = intent.motion !== "still";
  const activity = !activityAvailable
    ? "none"
    : intent.activity === "surprise"
      ? ["asteroids", "orbit", "recent", "recent", "subtle"][
          Math.floor(random() * 5)
        ]
      : intent.activity;
  Object.assign(options, {
    includeRepos: [...intent.projects],
    maxRepos: intent.projects.length,
    repoSource: "all",
    includeForks: true,
    includeArchived: true,
    minStars: 0,
    updatedWithin: 0,
    repoQuery: "",
    ...(intent.projectShowcase
      ? { projectShowcase: structuredClone(intent.projectShowcase) }
      : {}),
    languages: intent.languages,
    topics: intent.topics?.length ? intent.topics : null,
    showOther: true,
    nodeMode:
      { languages: "languages", topics: "topics", everything: "combined" }[
        intent.relationships
      ] || "repositories",
    connectionBasis:
      intent.relationships === "languages"
        ? "languages"
        : intent.relationships === "topics"
          ? "topics"
          : "both",
    hiddenNodes: [],
    hiddenLabels: [],
    activityEffect:
      activity === "asteroids"
        ? "asteroids"
        : activity === "recent"
          ? "pulse"
          : activity === "subtle"
            ? "glow"
            : "off",
    activityAnimate: motion,
    codingRhythm: false,
    contributionComet: { enabled: false },
    contributionOrbit: { enabled: activity === "orbit", animate: motion },
    foreignGalaxies: { enabled: false },
    stellarAges: { enabled: false },
    history: { mode: "current", year: null, timeLapse: { enabled: false } },
    languageEvolution: { enabled: false },
    animate: motion,
    starlightAnimate: motion,
    legend: true,
  });
  if (intent.vibe !== "surprise") {
    const preset = presetOptions(
      intent.vibe === "clean"
        ? "minimal-readme"
        : intent.vibe === "technical"
          ? "technology-atlas"
          : "project-map",
    );
    options.visualTheme =
      intent.vibe === "classic" ? "constellation" : preset.visualTheme;
    delete options.visualStyle;
    if (intent.vibe === "clean") {
      options.layout = preset.layout;
      options.legend = preset.legend;
      options.starfield = { mode: "classic", density: 20, twinkle: false };
    }
  }
  if (!motion) {
    options.ringAnimation.enabled = false;
    options.ringAnimation.speeds = [0, 0, 0, 0];
    options.perspective.animate = false;
    options.floatingAnimation.enabled = false;
    options.starfield.twinkle = false;
  }
  return {
    config: parseConfig({ version: CONFIG_VERSION, account, options }),
    activity,
    history,
  };
}
