import { beforeEach, describe, expect, it } from "vitest";
import { classifyReadme } from "../src/repository-audit/classify.js";
import { reviewReadme } from "../src/repository-audit/review.js";
import {
  PLAN_LIMIT,
  findingTitle,
  improvementPlan,
  planDecision,
  sessionDecisions,
} from "../src/repository-audit/improvement-plan.js";
import {
  attentionItem,
  attentionQueue,
} from "../src/repository-audit/attention.js";
import { projectTypes } from "../src/repository-audit/project-types.js";
import { invalidateHealth } from "../src/github/health-cache.js";

const now = Date.parse("2026-09-28T12:00:00Z"),
  day = 86400000;
const sha = "abcdef1".padEnd(40, "0");
const prose =
  "This repository explores practical approaches to local data storage and documents the tradeoffs observed while comparing several implementations in a reproducible way.";
const paragraph = (topic) =>
  `The ${topic} part explains clearly how people prepare their machines, which tools they need, where the files live, and why each choice keeps the project predictable for new contributors arriving later.`;
const detailed = [
  "# Notes tool",
  prose,
  paragraph("overview"),
  "## Installation",
  `${paragraph("installation")} Install it with the package manager before you continue with the rest of these notes.`,
  "```sh\nnpm install notes-tool\n```",
  "## Usage",
  `${paragraph("usage")} Run the command from any folder that contains notes and read the generated summary.`,
  "## Links",
  `${paragraph("links")} Read the [full guide](https://example.org/guide) and the [changelog](https://example.org/changes) for more detail about releases.`,
  paragraph("closing"),
  paragraph("support"),
  paragraph("history"),
].join("\n\n");

const record = (name, source = prose, extra = {}, more = {}) => {
  const repo = {
    name,
    full_name: `example/${name}`,
    default_branch: "main",
    pushed_at: new Date(now - 3 * day).toISOString(),
    topics: [],
    ...extra,
  };
  return {
    repo,
    result: classifyReadme(source, repo),
    readme: source === null ? { path: null } : { path: "README.md", sha },
    checkedAt: now,
    ...more,
  };
};
const ids = (plan) => plan.recommendations.map((rec) => rec.id);
const band = (plan, id) => plan.recommendations.find((r) => r.id === id)?.band;
const response = (status) => new Response("{}", { status });

// Check history and links runs two hours after the audit read the README.
const later = now + 2 * 3600000;
async function reviewed(rec, source, links = []) {
  const commits = Array.from({ length: 10 }, (_, i) => ({
    sha: `c${i}`,
    commit: { committer: { date: new Date(now - i * day).toISOString() } },
  }));
  rec.review = await reviewReadme(
    rec.repo,
    { source, path: "README.md", sha },
    {
      client: {
        now: () => later,
        history: async () => ({ updated: "2026-01-01T00:00:00Z", commits }),
        fetcher: async (url) =>
          response(links.some((l) => url.includes(l)) ? 404 : 200),
      },
    },
  );
  return rec;
}

beforeEach(() => invalidateHealth());

describe("finding kinds map to Recommendations and Plan bands", () => {
  it("starts a missing README with one Recommendation listing key topics", () => {
    const plan = improvementPlan(record("missing", null, { topics: ["cli"] }));
    expect(ids(plan)).toEqual(["readme:missing"]);
    const [rec] = plan.recommendations;
    expect(rec).toMatchObject({ band: "start", title: "Add a root README" });
    expect(rec.consider).toEqual([
      "Installation",
      "Commands",
      "Flags / options",
      "Examples",
    ]);
    expect(rec.evidence).toContain("GitHub reports no README");
    expect(rec.evidence).toContain("no root README");
    expect(rec.actions).toEqual(["improve", "open", "skip", "minimal"]);
    expect(plan.revision).toBe("missing-root");
  });
  it("folds a stub into one Start-here Recommendation without a topic flood", () => {
    const badgeOnly =
      "[![Build](https://img.shields.io/badge/build-passing-green.svg)](https://example.org/ci)";
    const plan = improvementPlan(
      record("badges", badgeOnly, { topics: ["library"] }),
    );
    expect(plan.state).toBe("stub");
    expect(ids(plan)).toEqual(["readme:thin"]);
    expect(plan.recommendations[0].band).toBe("start");
    expect(plan.recommendations[0].consider).toContain("Installation");
    expect(plan.recommendations[0].actions).toContain("minimal");
    expect(plan.recommendations[0].actions).not.toContain("dismiss");
  });
  it("maps a minimal README to thin, key topics as Next and the rest as Optional", () => {
    const plan = improvementPlan(record("game", prose, { topics: ["game"] }));
    expect(plan.state).toBe("minimal");
    expect(ids(plan)).toEqual([
      "readme:thin",
      "topic:controls",
      "topic:setup",
      "topic:gameplay",
      "topic:build",
      "topic:visuals",
    ]);
    expect(band(plan, "readme:thin")).toBe("start");
    expect(band(plan, "topic:controls")).toBe("next");
    expect(band(plan, "topic:visuals")).toBe("optional");
    expect(plan.recommendations[1].title).toBe("Add a Controls section");
    expect(plan.recommendations[1].evidence[0]).toBe(
      "Controls: no populated heading matched",
    );
    expect(plan.recommendations[1].applicability).toContain(
      "may be covered under another heading or linked elsewhere",
    );
    expect(plan.recommendations[1].applicability).toContain(
      "Game (type from repository topic “game”)",
    );
  });
  it("maps placeholders and starters to Start here", () => {
    const source = `# your-project-name\n\nTODO: describe it. ${prose}\n\n## Available Scripts\n\nThis project was bootstrapped with Create React App and explains the scripts people can run.`;
    const plan = improvementPlan(record("starter", source));
    expect(
      plan.recommendations
        .filter((r) => r.band === "start")
        .map((r) => r.id)
        .slice(1),
    ).toEqual([
      "starter:create-react-app",
      "placeholder:project-name",
      "placeholder:todo",
    ]);
    expect(findingTitle("starter:vite")).toBe("Replace Vite starter text");
    expect(findingTitle("starter:nextjs")).toBe("Replace Next.js starter text");
  });
  it("maps unavailable links and images to Next and history to Optional", async () => {
    const source = `${detailed}\n\n![Diagram](https://example.org/gone.png)\n\n[Old](https://example.org/old)`;
    const rec = await reviewed(record("linked", source), source, [
      "gone.png",
      "/old",
    ]);
    const plan = improvementPlan(rec);
    const link = plan.recommendations.find((r) => r.id.startsWith("link:"));
    const image = plan.recommendations.find((r) => r.id.startsWith("image:"));
    expect(link.id).toMatch(/^link:unavailable:fnv1a32:[\da-f]{8}$/);
    expect(link).toMatchObject({
      band: "next",
      title: "Review unavailable link",
      url: "https://example.org/old",
    });
    expect(link.evidence.slice(0, 2)).toEqual([
      "https://example.org/old",
      "HTTP 404/410 at check time",
    ]);
    expect(image).toMatchObject({
      band: "next",
      title: "Review unavailable image",
    });
    const history = plan.recommendations.find(
      (r) => r.id === "history:activity-after-readme",
    );
    expect(history.band).toBe("optional");
    expect(history.evidence.slice(0, 2)).toEqual([
      "Last observed README update: 2026-01-01",
      "10 distinct recent commits after it, spanning at least seven days",
    ]);
    // Their evidence cites when the check ran, not when the audit read the README.
    for (const rec of [link, image, history]) {
      expect(rec.evidence).toContain("Checked 2026-09-28T14:00:00.000Z");
      expect(rec.evidence).not.toContain("Observed 2026-09-28T12:00:00.000Z");
      expect(rec.evidence).toContain("README revision abcdef1");
    }
    delete rec.review.reviewedAt;
    expect(
      improvementPlan(rec).recommendations.find((r) => r.id === link.id)
        .evidence,
    ).toContain("Check time unknown");
  });
});

describe("plans are deterministic, bounded and explainable", () => {
  it("orders by band, kind, profile topic and ID, and caps at 30", async () => {
    const links = Array.from(
      { length: 20 },
      (_, i) => `[Link ${i}](https://example.org/l${i})`,
    ).join("\n");
    const source = `# your-project-name\n\nTODO ${prose}\n\n## Available Scripts\n\nThis project was bootstrapped with Create React App.\n\n${links}`;
    const rec = await reviewed(
      record("many", source, { topics: ["library"] }),
      source,
      ["example.org/l"],
    );
    const plan = improvementPlan(rec);
    expect(plan.recommendations).toHaveLength(PLAN_LIMIT);
    expect(plan.omitted).toBeGreaterThan(0);
    const order = { start: 0, next: 1, optional: 2 };
    const bands = plan.recommendations.map((r) => order[r.band]);
    expect(bands).toEqual([...bands].sort((a, b) => a - b));
    expect(ids(plan).slice(0, 4)).toEqual([
      "readme:thin",
      "starter:create-react-app",
      "placeholder:project-name",
      "placeholder:todo",
    ]);
    expect(improvementPlan(rec)).toEqual(plan);
    expect(new Set(ids(plan)).size).toBe(plan.recommendations.length);
  });
  it("gives every Recommendation evidence, applicability, revision and observed time", async () => {
    const source = `TODO ${prose}\n\n[Old](https://example.org/old)`;
    const rec = await reviewed(
      record("every", source, { topics: ["api"] }),
      source,
      ["/old"],
    );
    const plan = improvementPlan(rec);
    expect(plan.recommendations.length).toBeGreaterThan(5);
    for (const r of plan.recommendations) {
      expect(r.evidence.length).toBeGreaterThan(2);
      expect(r.evidence).toContain("README revision abcdef1");
      expect(r.evidence).toContain(
        /^(link|image|history):/.test(r.id)
          ? "Checked 2026-09-28T14:00:00.000Z"
          : "Observed 2026-09-28T12:00:00.000Z",
      );
      expect(r.applicability).toMatch(/API \(type from repository topic/);
      expect(r.title).toMatch(/^(Add|Replace|Review|Expand)\b/);
    }
  });
  it("never invents content: titles and evidence carry no commands or new URLs", async () => {
    const source = `${prose}\n\n[Old](https://example.org/old)`;
    const rec = await reviewed(
      record("facts", source, { topics: ["cli"] }),
      source,
      ["/old"],
    );
    const text = JSON.stringify(improvementPlan(rec));
    const urls = text.match(/https?:\/\/[^"\s)]+/g) || [];
    expect(urls.every((url) => url === "https://example.org/old")).toBe(true);
    expect(text).not.toMatch(/npm install|cargo |pip install|\$ /);
  });
  it("returns no plan for failed or unaudited records", () => {
    expect(improvementPlan(undefined)).toBe(null);
    expect(improvementPlan({ repo: { full_name: "example/x" } })).toBe(null);
    expect(
      improvementPlan({
        repo: { full_name: "example/x" },
        error: "Rate limited",
        kind: "rate-limit",
        checkedAt: now,
      }),
    ).toBe(null);
  });
  it("returns an empty plan for a detailed README", () => {
    const plan = improvementPlan(record("detailed", detailed));
    expect(plan.state).toBe("detailed");
    expect(plan.recommendations).toEqual([]);
    expect(plan.caveats).toEqual([]);
    expect(plan.hidden).toEqual({ dismissed: [], stale: [], skipped: [] });
  });
  it("keeps finding IDs stable", async () => {
    const source = `# your-project-name\n\nTODO ${prose}\n\n[Old](https://example.org/old)\n\n![Gone](https://example.org/gone.png)`;
    const rec = await reviewed(
      record("stable", source, { topics: ["web-app"] }),
      source,
      ["/old", "gone.png"],
    );
    expect(ids(improvementPlan(rec)).sort()).toEqual([
      "history:activity-after-readme",
      // sourceHash of https://example.org/gone.png and https://example.org/old
      "image:unavailable:fnv1a32:08c19b6f",
      "link:unavailable:fnv1a32:4eabad4e",
      "placeholder:project-name",
      "placeholder:todo",
      "readme:thin",
      "topic:configuration",
      "topic:deployment",
      "topic:setup",
      "topic:testing",
    ]);
    expect(ids(improvementPlan(record("gone", null)))).toEqual([
      "readme:missing",
    ]);
  });
});

describe("type-specific false positives", () => {
  it("does not ask a CLI with a Usage heading for commands", () => {
    const source = `${prose}\n\n## Usage\n\nRun the tool with a folder path and it prints a summary of every note found there.`;
    const plan = improvementPlan(record("tool", source, { topics: ["cli"] }));
    expect(ids(plan)).not.toContain("topic:commands");
    expect(ids(plan)).toContain("topic:installation");
  });
  it("keeps the API reference Optional with a caveat when external docs are linked", () => {
    const source = `${prose}\n\nRead the [documentation](https://docs.example.org) for every function.`;
    const plan = improvementPlan(
      record("lib", source, { topics: ["library"] }),
    );
    const api = plan.recommendations.find((r) => r.id === "topic:api");
    expect(api.band).toBe("optional");
    expect(api.applicability).toContain(
      "README has 1 link whose text or address names documentation, which may be a deliberate alternative",
    );
    expect(band(plan, "topic:installation")).toBe("next");
  });
  it("keeps the API reference in Next when the only links are not documentation", () => {
    const source = [
      "# Parser lib",
      paragraph("overview"),
      "## Installation",
      paragraph("installation"),
      "```sh\nnpm i parser-lib\n```",
      "## Usage",
      paragraph("usage"),
      "## License",
      "Released under the MIT license, see [LICENSE](LICENSE) for the full text. Visit the [website](https://parser.example.org) or the [status page](https://status.parser.example.org).",
    ].join("\n\n");
    const rec = record("parser", source, { topics: ["library"] });
    expect(rec.result.metrics.projectLinks).toBe(3);
    expect(rec.result.metrics.documentationLinks).toBe(0);
    const api = improvementPlan(rec).recommendations.find(
      (r) => r.id === "topic:api",
    );
    expect(api.band).toBe("next");
    expect(api.applicability).not.toContain("names documentation");
    // Link text or an address naming documentation counts, relative or not.
    for (const link of [
      "[API reference](https://parser.example.org/v1)",
      "[Read more](docs/usage.md)",
      "[Read more](https://parser.readthedocs.io)",
    ])
      expect(
        classifyReadme(`${prose}\n\n${link}`).metrics.documentationLinks,
      ).toBe(1);
  });
  it("says authentication may not apply to a public API", () => {
    const plan = improvementPlan(record("svc", prose, { topics: ["api"] }));
    expect(
      plan.recommendations.find((r) => r.id === "topic:authentication")
        .applicability,
    ).toContain("does not apply to APIs without authentication");
  });
  it("notes that a LICENSE file may already cover the license topic", () => {
    const plan = improvementPlan(
      record("oss", prose, { topics: ["open-source"] }),
    );
    const license = plan.recommendations.find((r) => r.id === "topic:license");
    expect(license.band).toBe("optional");
    expect(license.applicability).toContain("the audit does not read it");
  });
  it("gives an Experiment with a substantive overview only Optional findings", () => {
    const plan = improvementPlan(
      record("lab", prose, { topics: ["experiment"] }),
    );
    expect(plan.state).toBe("basic");
    expect(ids(plan)).toEqual(["topic:findings"]);
    expect(plan.recommendations.every((r) => r.band === "optional")).toBe(true);
    expect(plan.recommendations[0].applicability).toContain(
      "findings are optional for an experiment",
    );
  });
  it("never asks a Documentation repository for installation or a Game for an API", () => {
    expect(
      ids(improvementPlan(record("docs", prose, { topics: ["docs"] }))),
    ).not.toContain("topic:installation");
    expect(
      ids(improvementPlan(record("play", prose, { topics: ["game"] }))),
    ).not.toContain("topic:api");
  });
  it("downgrades topics when the type is only a name hint or a fallback", () => {
    for (const name of ["sample-cli", "notes"]) {
      const plan = improvementPlan(record(name, prose));
      expect(plan.typeSource).toBe(name === "notes" ? "fallback" : "name");
      expect(plan.caveats).toContain(
        "Project type is a weak inference; choose a type if this is wrong",
      );
      expect(band(plan, "readme:thin")).toBe("start");
      expect(
        plan.recommendations
          .filter((r) => r.id.startsWith("topic:"))
          .every((r) => r.band === "optional"),
      ).toBe(true);
    }
    const chosen = improvementPlan(record("sample-cli", prose), {
      override: "cli",
    });
    expect(chosen.typeSource).toBe("manual");
    expect(chosen.caveats).toEqual([]);
    expect(band(chosen, "topic:installation")).toBe("next");
    expect(chosen.recommendations[1].applicability).toContain(
      "CLI (type chosen by you)",
    );
  });
  it("downgrades topics when headings may not be in English", () => {
    const es =
      "Esta herramienta organiza notas personales en carpetas locales y genera resúmenes legibles sin enviar nada a servicios remotos ni depender de cuentas externas.";
    const source = `# Notas\n\n${es}\n\n## Instalación\n\n${es} Descarga el archivo comprimido y colócalo en una carpeta de tu equipo.\n\n## Uso\n\n${es} Abre la terminal y escribe el nombre de la herramienta seguido de la carpeta.`;
    const plan = improvementPlan(record("notas", source, { topics: ["cli"] }));
    expect(plan.caveats).toEqual([
      "Headings may not be in English; topic detection uses English terms",
    ]);
    expect(
      plan.recommendations
        .filter((r) => r.id.startsWith("topic:"))
        .every((r) => r.band === "optional"),
    ).toBe(true);
    // An English README with recognised headings gets no language caveat.
    expect(
      improvementPlan(
        record(
          "english",
          `# Notes\n\n${prose}\n\n## Background\n\n${prose}\n\n## Contributing\n\n${prose}`,
          { topics: ["cli"] },
        ),
      ).caveats,
    ).toEqual([]);
  });
  it("keeps key topics in Next when only Overview, Examples or Links headings matched", () => {
    for (const heading of ["Overview", "Examples", "Links"]) {
      const source = [
        "# Notes",
        `## ${heading}`,
        paragraph("overview"),
        paragraph("design"),
        "## Background",
        paragraph("background"),
        paragraph("history"),
      ].join("\n\n");
      const plan = improvementPlan(
        record("notes", source, { topics: ["cli"] }),
      );
      expect(plan.caveats).toEqual([]);
      expect(band(plan, "topic:installation")).toBe("next");
      expect(band(plan, "topic:commands")).toBe("next");
    }
  });
  it("ignores TODO inside a code fence", () => {
    const plan = improvementPlan(
      record("fenced", `${prose}\n\n\`\`\`md\nTODO your-project-name\n\`\`\``),
    );
    expect(ids(plan).filter((id) => id.startsWith("placeholder:"))).toEqual([]);
  });
  it("gives an archived or long-inactive repository the same plan", () => {
    const active = improvementPlan(record("same", prose, { topics: ["cli"] }));
    const archived = improvementPlan(
      record("same", prose, {
        topics: ["cli"],
        archived: true,
        pushed_at: "2019-01-01T00:00:00Z",
        stargazers_count: 5000,
      }),
    );
    expect(archived).toEqual(active);
  });
});

describe("session Skip and Dismiss", () => {
  const session = () => ({ skipped: new Map(), dismissed: new Map() });
  it("hides skipped and dismissed Recommendations and restores them", () => {
    const state = session();
    const rec = record("Game", prose, { topics: ["game"] });
    const options = () => sessionDecisions(state, "example/Game");
    planDecision(state, {
      repository: "example/Game",
      id: "topic:visuals",
      action: "skip",
      revision: `sha:${sha}`,
    });
    expect(
      planDecision(state, {
        repository: "example/Game",
        id: "topic:controls",
        action: "dismiss",
        revision: `sha:${sha}`,
      }),
    ).toContain("on this device for README revision abcdef1");
    expect(state.dismissed.get("example/game").get("topic:controls")).toBe(
      `sha:${sha}`,
    );
    let plan = improvementPlan(rec, options());
    expect(ids(plan)).not.toContain("topic:visuals");
    expect(ids(plan)).not.toContain("topic:controls");
    expect(plan.hidden.skipped.map((r) => r.id)).toEqual(["topic:visuals"]);
    expect(plan.hidden.dismissed.map((r) => r.id)).toEqual(["topic:controls"]);
    for (const id of ["topic:visuals", "topic:controls"])
      planDecision(state, {
        repository: "example/game",
        id,
        action: "restore",
      });
    plan = improvementPlan(rec, options());
    expect(ids(plan)).toContain("topic:visuals");
    expect(ids(plan)).toContain("topic:controls");
    expect(plan.hidden.skipped).toEqual([]);
  });
  it("refuses to dismiss thin READMEs or without a known revision", () => {
    const state = session();
    expect(() =>
      planDecision(state, {
        repository: "example/a",
        id: "readme:thin",
        action: "dismiss",
        revision: `sha:${sha}`,
      }),
    ).toThrow("intentionally minimal");
    expect(() =>
      planDecision(state, {
        repository: "example/a",
        id: "topic:setup",
        action: "dismiss",
        revision: "",
      }),
    ).toThrow("Refresh the audit to obtain a README revision");
    expect(state.dismissed.size).toBe(0);
  });
  it("shows a dismissal for an earlier revision as stale and does not apply it", () => {
    const rec = record("game", prose, { topics: ["game"] });
    const dismissed = new Map([["topic:controls", `sha:${"b".repeat(40)}`]]);
    const plan = improvementPlan(rec, { decisions: { dismissed } });
    expect(ids(plan)).toContain("topic:controls");
    expect(plan.hidden.stale.map((r) => r.id)).toEqual(["topic:controls"]);
    expect(plan.hidden.dismissed).toEqual([]);
    expect(
      attentionItem(rec, { now, dismissed }).gaps.includes("controls"),
    ).toBe(true);
  });
  it("does not call a dismissal stale when the current revision is unknown", () => {
    const rec = record("game", prose, { topics: ["game"] });
    rec.readme.sha = "";
    const dismissed = new Map([["topic:controls", `sha:${sha}`]]);
    const plan = improvementPlan(rec, { decisions: { dismissed } });
    const controls = plan.recommendations.find(
      (r) => r.id === "topic:controls",
    );
    expect(controls.stale).toBeUndefined();
    expect(controls.unverified).toBe(`sha:${sha}`);
    expect(plan.hidden.stale).toEqual([]);
    expect(plan.hidden.dismissed).toEqual([]);
  });
  it("never hides a thin README through a dismissal", () => {
    const dismissed = new Map([["readme:thin", `sha:${sha}`]]);
    const tiny = record("tiny", "# Tiny");
    const plan = improvementPlan(tiny, { decisions: { dismissed } });
    expect(ids(plan)).toContain("readme:thin");
    expect(plan.hidden.dismissed).toEqual([]);
    expect(attentionItem(tiny, { now, dismissed }).priority).toBe("high");
  });
});

describe("queue reasons and eligibility with dismissals", () => {
  const basicGame =
    prose +
    "\n\n## Controls\n\nUse the arrow keys to move your character through the world and discover new areas.\n\n## Gameplay\n\nCollect items and finish each level to unlock the next stage of the story.";
  it("drops a dismissed gap and finding from queue reasons", () => {
    const rec = record("Swing", `TODO ${prose}`, { topics: ["game"] });
    const dismissed = new Map([
      ["topic:controls", `sha:${sha}`],
      ["placeholder:todo", `sha:${sha}`],
    ]);
    const before = attentionItem(rec, { now }).reasons.join(" ");
    expect(before).toContain("Game controls not detected");
    expect(before).toContain("Possible unresolved TODO");
    const item = attentionQueue([rec], {
      now,
      dismissals: new Map([["example/swing", dismissed]]),
    })[0];
    expect(item.gaps).not.toContain("controls");
    expect(item.reasons.join(" ")).not.toContain("Game controls");
    expect(item.reasons.join(" ")).not.toContain("TODO");
    expect(item.priority).toBe("high");
  });
  it("removes an item whose only signals are dismissed", () => {
    const rec = record("basic", basicGame, { topics: ["game"] });
    const item = attentionItem(rec, { now });
    expect(item.priority).toBe("medium");
    const dismissed = new Map(
      item.gaps.map((key) => [`topic:${key}`, `sha:${sha}`]),
    );
    expect(attentionItem(rec, { now, dismissed })).toBe(null);
    // A dismissal for another README revision is not applied.
    const stale = new Map(
      item.gaps.map((key) => [`topic:${key}`, `sha:${"c".repeat(40)}`]),
    );
    expect(attentionItem(rec, { now, dismissed: stale })).not.toBe(null);
  });
  it("reads key topics from each project type", () => {
    for (const type of projectTypes) {
      expect(type.key.length).toBeGreaterThan(0);
      expect(type.key.every((key) => type.topics.includes(key))).toBe(true);
    }
  });
});
