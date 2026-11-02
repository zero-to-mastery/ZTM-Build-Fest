import { describe, it, expect } from "vitest";
import { analyzeManifest } from "../src/stack-intelligence/manifests.js";
import {
  CONFIDENCE_BASES,
  UNCERTAIN_BASES,
  basisExplanation,
  confidenceBasis,
  normalizeDependencies,
  staleness,
  uncertainResults,
} from "../src/stack-intelligence/dependencies.js";
import { StackClient, scanStacks } from "../src/stack-intelligence/client.js";
import { stackDNA } from "../src/stack-intelligence/dna.js";
import { AuditError } from "../src/repository-audit/github.js";
import "../src/components/stack-results.js";

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-03-01T12:00:00Z");
const repo = {
  full_name: "Example/App",
  default_branch: "main",
  language: "TypeScript",
  pushed_at: "2026-03-01T11:00:00Z",
};
const file = (path, source, sha = "f".repeat(40)) => ({
  type: "file",
  path,
  size: Buffer.byteLength(source),
  encoding: "base64",
  content: Buffer.from(source).toString("base64"),
  sha,
});
// A mocked root-only AuditClient: a root listing plus the given files.
// `fail` maps a path to the error its contents request throws.
function mockClient(files, { fail = {} } = {}) {
  const calls = [];
  const request = async (path) => {
    calls.push(path);
    const match = path.match(/^\/repos\/example\/app\/contents\/(.*)\?ref=/);
    if (!match) throw Error("Unexpected request " + path);
    if (!match[1])
      return {
        data: Object.keys(files).map((p) => ({ type: "file", path: p })),
      };
    const name = decodeURIComponent(match[1]);
    if (fail[name]) throw fail[name];
    return { data: file(name, files[name]) };
  };
  return { client: { request }, calls };
}
const basesOf = (path, source) =>
  analyzeManifest(path, source).entries.map((entry) => [
    entry.name,
    entry.role,
    entry.evidence,
    confidenceBasis(entry, path),
  ]);

describe("Confidence basis (#132)", () => {
  it("assigns a basis for every package.json field, aliases included", () => {
    expect(
      basesOf(
        "package.json",
        JSON.stringify({
          dependencies: { react: "19", alias: "npm:@scope/real@1" },
          devDependencies: { vitest: "4" },
          peerDependencies: { vue: "3" },
          optionalDependencies: { sharp: "1", other: "npm:real-other@2" },
        }),
      ),
    ).toEqual([
      ["react", "runtime", "dependencies", "explicit"],
      ["@scope/real", "runtime", "dependencies (alias: alias)", "ambiguous"],
      ["vitest", "development", "devDependencies", "explicit"],
      ["vue", "peer", "peerDependencies", "conditional"],
      ["sharp", "optional", "optionalDependencies", "conditional"],
      [
        "real-other",
        "optional",
        "optionalDependencies (alias: other)",
        "ambiguous",
      ],
    ]);
  });
  it("assigns a basis for every Cargo table, inheritance and target", () => {
    expect(
      basesOf(
        "Cargo.toml",
        `
[workspace.dependencies]
shared = "1"
opt-shared = "1"
[dependencies]
serde = "1"
renamed = { package = "actual", version = "1" }
shared = { workspace = true }
maybe = { version = "1", optional = true }
opt-shared = { workspace = true, optional = true }
[dev-dependencies]
insta = "1"
[build-dependencies]
cc = "1"
[target.'cfg(unix)'.dependencies]
libc = "0.2"
[target.'cfg(unix)'.dev-dependencies]
nix = "0.1"
`,
      ).map(([name, role, , basis]) => [name, role, basis]),
    ).toEqual([
      ["serde", "runtime", "explicit"],
      ["actual", "runtime", "explicit"],
      ["shared", "runtime", "inherited"],
      ["maybe", "optional", "conditional"],
      ["opt-shared", "optional", "conditional"],
      ["insta", "development", "explicit"],
      ["cc", "build", "conditional"],
      ["libc", "runtime", "conditional"],
      ["nix", "development", "conditional"],
    ]);
  });
  it("assigns a basis for every pyproject field, Poetry included", () => {
    expect(
      basesOf(
        "pyproject.toml",
        `
[project]
dependencies = ["requests"]
[project.optional-dependencies]
docs = ["mkdocs"]
[build-system]
requires = ["setuptools"]
[dependency-groups]
test = ["pytest"]
[tool.poetry.dependencies]
python = "^3.12"
httpx = "*"
psycopg2 = { version = "^2.9", optional = true }
[tool.poetry.dependencies.uvicorn]
version = "*"
optional = true
[tool.poetry.group.dev.dependencies]
ruff = "*"
`,
      ).map(([name, role, , basis]) => [name, role, basis]),
    ).toEqual([
      ["requests", "runtime", "explicit"],
      ["mkdocs", "optional", "conditional"],
      ["setuptools", "build", "conditional"],
      ["pytest", "development", "explicit"],
      ["httpx", "runtime", "explicit"],
      // Poetry extras (`optional = true`) are conditional like Cargo's.
      ["psycopg2", "optional", "conditional"],
      ["uvicorn", "optional", "conditional"],
      ["ruff", "development", "explicit"],
    ]);
  });
  it("treats requirements.txt as ambiguous and go.mod require as explicit", () => {
    expect(basesOf("requirements.txt", "requests==2\nflask\n")).toEqual([
      ["requests", "runtime", "requirements.txt", "ambiguous"],
      ["flask", "runtime", "requirements.txt", "ambiguous"],
    ]);
    expect(
      basesOf(
        "go.mod",
        "module x\nrequire (\n\texample.org/a v1.0.0\n\texample.org/b v1.0.0 // indirect\n)\n",
      ),
    ).toEqual([["example.org/a", "runtime", "require", "explicit"]]);
  });
  it("defaults to ambiguous for files it does not know", () => {
    expect(
      confidenceBasis(
        { name: "x", role: "runtime", evidence: "deps" },
        "setup.py",
      ),
    ).toBe("ambiguous");
    expect(confidenceBasis(undefined, undefined)).toBe("ambiguous");
  });
  it("has one fixed explanation per basis, with no numbers, rankings or skill wording", () => {
    expect(Object.isFrozen(CONFIDENCE_BASES)).toBe(true);
    expect(Object.keys(CONFIDENCE_BASES)).toEqual([
      "explicit",
      "inherited",
      "conditional",
      "ambiguous",
    ]);
    expect(UNCERTAIN_BASES).toEqual(["conditional", "ambiguous"]);
    for (const text of Object.values(CONFIDENCE_BASES)) {
      expect(text).not.toMatch(/skill|proficien|expert|experience/i);
      expect(text).not.toMatch(/\d|%|percent|score|rank/i);
      expect(text.length).toBeGreaterThan(20);
    }
  });
});

describe("Provenance (#132)", () => {
  const files = {
    "package.json": JSON.stringify({
      engines: { node: ">=20" },
      dependencies: { react: "19" },
      peerDependencies: { vue: "3" },
    }),
    "Cargo.toml": '[dependencies]\nserde = "1"\n',
    "requirements.txt": "requests==2\n",
  };
  it("gives every Declaration and engine signal a complete Provenance", async () => {
    const { client } = mockClient(files);
    const record = await new StackClient({ client, now: () => T0 }).repository(
      repo,
    );
    expect(record.version).toBe(5);
    expect(record.observedAt).toBe(T0);
    expect(record.checkedAt).toBe(record.observedAt);
    expect(record.pushedAt).toBe(repo.pushed_at);
    const evidence = record.dependencies.flatMap((d) => d.evidence);
    expect(evidence).toHaveLength(4);
    for (const item of evidence) {
      expect(Object.keys(item).sort()).toEqual(
        [
          "basis",
          "blobSha",
          "branch",
          "line",
          "manifest",
          "observedAt",
          "project",
          "repository",
          "section",
        ].sort(),
      );
      expect(item.repository).toBe("example/app");
      expect(item.manifest).toBeTruthy();
      expect(item.observedAt).toBe(T0);
      expect(item.branch).toBe("main");
      expect(item.blobSha).toBe("f".repeat(40));
      // The explanation is looked up when shown, not repeated in the cache.
      expect(basisExplanation(item.basis)).toBe(CONFIDENCE_BASES[item.basis]);
    }
    expect(
      record.dependencies.map((d) => [d.name, d.evidence[0].basis]),
    ).toEqual([
      ["react", "explicit"],
      ["vue", "conditional"],
      ["requests", "ambiguous"],
      ["serde", "explicit"],
    ]);
    expect(
      record.dependencies.find((d) => d.name === "serde").evidence[0].line,
    ).toBe(2);
    const [signal] = record.manifests.find(
      (m) => m.path === "package.json",
    ).signals;
    expect(signal).toMatchObject({
      id: "nodejs",
      evidence: "engines.node",
      repository: "example/app",
      branch: "main",
      project: "",
      manifest: "package.json",
      section: "engines.node",
      line: null,
      observedAt: T0,
      basis: "explicit",
    });
    expect(signal.explanation).toBeUndefined();
  });
  it("keeps the original Observed at on a cache hit and renews it on a fresh read", async () => {
    const { client, calls } = mockClient(files);
    let now = T0;
    const stack = new StackClient({ client, now: () => now });
    await stack.repository(repo);
    now = T0 + 4 * 60 * 1000;
    const cached = await stack.repository({
      ...repo,
      pushed_at: "2026-03-01T12:03:00Z",
    });
    expect(calls).toHaveLength(4);
    expect(cached.observedAt).toBe(T0);
    expect(cached.checkedAt).toBe(T0);
    expect(cached.pushedAt).toBe(repo.pushed_at);
    expect(cached.dependencies[0].evidence[0].observedAt).toBe(T0);
    // The newer push makes the cached result Stale without a request.
    expect(
      staleness(cached, { ...repo, pushed_at: "2026-03-01T12:03:00Z" }, now),
    ).toEqual(["pushed-since"]);
    const fresh = await stack.repository(repo, { force: true });
    expect(calls).toHaveLength(8);
    expect(fresh.observedAt).toBe(now);
    expect(fresh.dependencies[0].evidence[0].observedAt).toBe(now);
  });
  it("ignores an unparseable pushed_at", async () => {
    const { client } = mockClient(files);
    const record = await new StackClient({ client, now: () => T0 }).repository({
      ...repo,
      pushed_at: "yesterday",
    });
    expect(record.pushedAt).toBe("");
  });
  it("normalizes analyzed manifests without a scan context", () => {
    const [dependency] = normalizeDependencies("example/app", [
      analyzeManifest("go.mod", "require example.org/a v1.0.0\n"),
    ]);
    expect(dependency.evidence).toEqual([
      {
        repository: "example/app",
        branch: "",
        project: "",
        manifest: "go.mod",
        blobSha: "",
        section: "require",
        line: 1,
        observedAt: null,
        basis: "explicit",
      },
    ]);
  });
});

describe("Stale stack results (#132)", () => {
  const record = { status: "read", observedAt: T0 };
  it("marks age only after more than 24 hours", () => {
    expect(staleness(record, null, T0 + 24 * HOUR)).toEqual([]);
    expect(staleness(record, null, T0 + 24 * HOUR + 1)).toEqual(["age"]);
  });
  it("marks a push after Observed at from the loaded repository list", () => {
    expect(
      staleness(record, { pushed_at: new Date(T0).toISOString() }, T0),
    ).toEqual([]);
    expect(
      staleness(record, { pushed_at: new Date(T0 + 1000).toISOString() }, T0),
    ).toEqual(["pushed-since"]);
    expect(
      staleness(
        record,
        { pushed_at: new Date(T0 + 1000).toISOString() },
        T0 + 25 * HOUR,
      ),
    ).toEqual(["pushed-since", "age"]);
  });
  it("compares pushes on GitHub's clock, not the local clock", () => {
    // The scan started from pushed_at 12:00; the local clock ran 3 minutes
    // slow, so Observed at is 11:57. An unchanged list is not a push.
    const pushedAt = "2026-10-22T12:00:00Z";
    const slow = {
      observedAt: Date.parse("2026-10-22T11:57:00Z"),
      pushedAt,
    };
    expect(staleness(slow, { pushed_at: pushedAt }, slow.observedAt)).toEqual(
      [],
    );
    // The local clock ran 10 minutes fast; a real push at 12:05 is still
    // after the scan-time pushed_at.
    const fast = {
      observedAt: Date.parse("2026-10-22T12:10:00Z"),
      pushedAt,
    };
    expect(
      staleness(fast, { pushed_at: "2026-10-22T12:05:00Z" }, fast.observedAt),
    ).toEqual(["pushed-since"]);
  });
  it("scans with a skewed clock and stays fresh until the next push", async () => {
    const serverNow = Date.parse("2026-10-22T12:00:00Z");
    const pushed = { ...repo, pushed_at: "2026-10-22T12:00:00Z" };
    const { client } = mockClient({
      "package.json": JSON.stringify({ dependencies: { react: "19" } }),
    });
    const record = await new StackClient({
      client,
      now: () => serverNow - 5 * 60 * 1000,
    }).repository(pushed);
    expect(record.pushedAt).toBe(pushed.pushed_at);
    expect(staleness(record, pushed, record.observedAt)).toEqual([]);
    expect(
      staleness(
        record,
        { ...pushed, pushed_at: "2026-10-22T12:01:00Z" },
        record.observedAt,
      ),
    ).toEqual(["pushed-since"]);
  });
  it("uses the checkedAt alias and ignores missing or invalid times", () => {
    expect(staleness({ checkedAt: T0 }, null, T0 + 25 * HOUR)).toEqual(["age"]);
    expect(staleness({}, { pushed_at: "2099-01-01T00:00:00Z" }, T0)).toEqual(
      [],
    );
    expect(staleness(record, { pushed_at: "not a date" }, T0)).toEqual([]);
    expect(staleness(record, {}, T0)).toEqual([]);
  });
});

describe("Partial results list unread manifests as unknown (#132)", () => {
  it("lists a failed manifest as not read and keeps the others", async () => {
    const { client } = mockClient(
      {
        "package.json": JSON.stringify({ dependencies: { react: "19" } }),
        "Cargo.toml": "[dependencies]\n",
      },
      { fail: { "Cargo.toml": new AuditError("network", "Offline.") } },
    );
    const record = await new StackClient({ client, now: () => T0 }).repository(
      repo,
    );
    expect(record.status).toBe("partial");
    const uncertain = uncertainResults(record);
    expect(uncertain.unread).toEqual([
      { path: "Cargo.toml", reason: "Offline." },
    ]);
    expect(record.dependencies.map((d) => d.name)).toEqual(["react"]);
  });
  it("lists manifests left unread after a rate limit stopped the scan", async () => {
    const { client } = mockClient(
      {
        "package.json": "{}",
        "Cargo.toml": "",
        "go.mod": "",
      },
      {
        fail: {
          "package.json": new AuditError("rate-limit", "Rate limited."),
        },
      },
    );
    const record = await new StackClient({ client, now: () => T0 }).repository(
      repo,
    );
    expect(record.stopped).toBe("Rate limited.");
    expect(uncertainResults(record).unread).toEqual([
      { path: "package.json", reason: "Rate limited." },
      { path: "Cargo.toml", reason: "not read; the scan stopped" },
      { path: "go.mod", reason: "not read; the scan stopped" },
    ]);
  });
  it("collects conditional and ambiguous declarations, and nothing from failed records", async () => {
    const { client } = mockClient({
      "package.json": JSON.stringify({
        dependencies: { react: "19" },
        peerDependencies: { vue: "3" },
      }),
      "requirements.txt": "flask\n",
    });
    const record = await new StackClient({ client, now: () => T0 }).repository(
      repo,
    );
    const { declarations, unread } = uncertainResults(record);
    expect(unread).toEqual([]);
    expect(declarations.map((d) => [d.name, d.kind, d.evidence.basis])).toEqual(
      [
        ["vue", "peer", "conditional"],
        ["flask", "runtime", "ambiguous"],
      ],
    );
    expect(
      uncertainResults({ ...record, status: "failed" }).declarations,
    ).toEqual([]);
    expect(uncertainResults(null)).toEqual({
      declarations: [],
      unread: [],
      unlisted: 0,
    });
  });
  it("counts unread manifests beyond the bounded skipped list", () => {
    const skipped = Array.from({ length: 50 }, (_, i) => ({
      path: `vendor/${i}/package.json`,
      reason: "excluded directory",
    }));
    const record = {
      status: "partial",
      dependencies: [],
      discovery: { found: 75, read: 5, skipped },
    };
    const { unread, unlisted } = uncertainResults(record);
    expect(unread).toHaveLength(50);
    expect(unlisted).toBe(20);
    const element = document.createElement("stack-results");
    document.body.append(element);
    element.setData([
      {
        ...record,
        repository: "Example/App",
        ref: "main",
        observedAt: T0,
        manifests: [],
        issues: [],
      },
    ]);
    const details = element.querySelector("details");
    details.open = true;
    details.ontoggle();
    // The heading matches the discovery summary: 70 not read.
    expect(element.querySelector("[data-discovery-summary]").textContent).toBe(
      "75 manifests found, 5 read, 70 not read. Root manifests only; nested manifests were not included.",
    );
    expect(element.querySelector("[data-uncertain] h3").textContent).toBe(
      "Uncertain stack results (70)",
    );
    expect(element.querySelector("[data-uncertain-unlisted]").textContent).toBe(
      "20 more manifests not read and not listed — unknown.",
    );
    element.remove();
  });
  it("gives failed records an Observed at and pushedAt but no evidence", async () => {
    const records = [];
    await scanStacks([repo], {
      client: {
        repository: async () => {
          throw new AuditError("network", "Offline.");
        },
      },
      onResult: (result) => records.push(result),
    });
    expect(records[0]).toMatchObject({
      version: 5,
      status: "failed",
      ref: "main",
      pushedAt: repo.pushed_at,
      manifests: [],
    });
    expect(records[0].observedAt).toBe(records[0].checkedAt);
    expect(Number.isFinite(records[0].observedAt)).toBe(true);
    expect(uncertainResults(records[0]).unread).toEqual([]);
    expect(stackDNA(records).technologies).toEqual([]);
  });
});

describe("Stack DNA provenance (#133)", () => {
  const scan = async (files, extra = {}) => {
    const { client } = mockClient(files);
    return new StackClient({ client, now: () => T0 }).repository({
      ...repo,
      ...extra,
    });
  };
  it("labels a technology with only conditional or ambiguous evidence", async () => {
    const record = await scan(
      {
        "package.json": JSON.stringify({
          dependencies: { react: "19" },
          peerDependencies: { vue: "3" },
        }),
        "requirements.txt": "flask\n",
      },
      { language: "" },
    );
    const dna = stackDNA([record]);
    const byName = Object.fromEntries(dna.technologies.map((t) => [t.name, t]));
    expect(byName.React.uncertainOnly).toBe(false);
    expect(byName.Vue.uncertainOnly).toBe(true);
    expect(byName.Flask.uncertainOnly).toBe(true);
    expect(byName.Vue.evidence[0]).toMatchObject({
      manifest: "package.json",
      section: "peerDependencies",
      branch: "main",
      blobSha: "f".repeat(40),
      observedAt: T0,
      basis: "conditional",
      explanation: CONFIDENCE_BASES.conditional,
      source: "package.json · peerDependencies",
    });
  });
  it("counts explicit evidence in any repository and metadata as certain", async () => {
    const peer = await scan({
      "package.json": JSON.stringify({ peerDependencies: { vue: "3" } }),
    });
    const { client } = mockClient({
      "package.json": JSON.stringify({ dependencies: { vue: "3" } }),
    });
    const direct = await new StackClient({ client, now: () => T0 }).repository({
      ...repo,
      full_name: "example/app",
    });
    expect(
      stackDNA([
        peer,
        { ...direct, repository: "example/other" },
      ]).technologies.find((t) => t.name === "Vue").uncertainOnly,
    ).toBe(false);
    const language = stackDNA([peer]).technologies.find(
      (t) => t.name === "TypeScript",
    );
    expect(language.uncertainOnly).toBe(false);
    expect(language.evidence[0]).toMatchObject({
      kind: "metadata",
      manifest: "",
      basis: "",
      branch: "main",
      observedAt: T0,
    });
  });
});

describe("stack-results rendering (#133)", () => {
  const render = async (files, repositories, now) => {
    const { client } = mockClient(files);
    const record = await new StackClient({ client, now: () => T0 }).repository(
      repo,
    );
    const element = document.createElement("stack-results");
    document.body.append(element);
    const realNow = Date.now;
    Date.now = () => now;
    try {
      element.setData([record], repositories);
      const details = element.querySelector("details");
      details.open = true;
      details.ontoggle();
    } finally {
      Date.now = realNow;
    }
    return element;
  };
  it("shows provenance, basis, uncertain results and the Stale badge as escaped text", async () => {
    const element = await render(
      {
        "package.json": JSON.stringify({
          dependencies: { react: "19", "<img src=x>": "1" },
          peerDependencies: { vue: "3" },
        }),
        "requirements.txt": "flask\n",
      },
      [{ ...repo, pushed_at: new Date(T0 + HOUR).toISOString() }],
      T0 + 25 * HOUR,
    );
    expect(element.querySelector("summary").textContent).toBe(
      "Example/App — Manifests read — Stale",
    );
    const stale = element.querySelector("[data-stale]").textContent;
    expect(stale).toContain("Stale: repository pushed after this scan");
    expect(stale).toContain("Stale: observed more than 24 hours ago");
    expect(stale).toContain("Fetch fresh manifests");
    const uncertain = element.querySelector("[data-uncertain]");
    expect(uncertain.querySelector("h3").textContent).toBe(
      "Uncertain stack results (2)",
    );
    expect(uncertain.textContent).toContain(CONFIDENCE_BASES.conditional);
    expect(uncertain.textContent).toContain(CONFIDENCE_BASES.ambiguous);
    const line = [...element.querySelectorAll("[data-dependencies] li li")]
      .map((li) => li.textContent)
      .find((text) => text.startsWith("package.json · peerDependencies"));
    expect(line).toContain("basis: conditional");
    expect(line).toContain("on main");
    expect(line).toContain("blob fffffff");
    const blob = element.querySelector("[data-blob]");
    expect(blob.title).toBe("Blob SHA " + "f".repeat(40));
    // The full SHA is text for keyboard and screen-reader users, not only a
    // title; the visible short form is hidden from assistive technology.
    expect(blob.querySelector(".sr-only").textContent).toBe(
      "SHA " + "f".repeat(40),
    );
    expect(blob.querySelector('[aria-hidden="true"]').textContent).toBe(
      "fffffff",
    );
    // Uncertain declarations stay in place in the dependency list.
    expect(element.querySelector("[data-dependencies]").textContent).toContain(
      "vue",
    );
    expect(element.querySelector("img")).toBeNull();
    expect(element.textContent).not.toMatch(/proficien|skill level|%/i);
    element.remove();
  });
  it("does not mark a fresh result Stale and states when nothing is uncertain", async () => {
    const element = await render(
      { "package.json": JSON.stringify({ dependencies: { react: "19" } }) },
      [repo],
      T0 + HOUR,
    );
    expect(element.querySelector("summary").textContent).toBe(
      "Example/App — Manifests read",
    );
    expect(element.querySelector("[data-stale]")).toBeNull();
    expect(element.querySelector("[data-uncertain]").textContent).toContain(
      "Uncertain stack results (0)",
    );
    element.remove();
  });
});
