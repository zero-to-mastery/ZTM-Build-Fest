import { describe, it, expect } from "vitest";
import {
  catalog,
  categories,
  technologyForDependency,
} from "../src/stack-intelligence/catalog.js";
import { stackDNA } from "../src/stack-intelligence/dna.js";
import { analyzeManifest } from "../src/stack-intelligence/manifests.js";
import { normalizeDependencies } from "../src/stack-intelligence/dependencies.js";
const record = (repository, sources, extra = {}) => {
  const manifests = Object.entries(sources).map(([path, source]) =>
    analyzeManifest(path, source),
  );
  return {
    repository,
    status: "read",
    manifests,
    dependencies: normalizeDependencies(repository, manifests),
    ...extra,
  };
};
const names = (model) => model.technologies.map((t) => t.name);
describe("curated Stack DNA", () => {
  it("has exactly the requested categories and no ambiguous package mappings", () => {
    expect(categories).toEqual([
      "Language",
      "Framework",
      "Runtime",
      "Testing",
      "Build",
      "Database",
      "Styling",
      "State Management",
      "API",
      "Deployment",
      "WebAssembly",
      "Utility",
      "Unknown",
    ]);
    expect(new Set(catalog.map((t) => t.id)).size).toBe(catalog.length);
    const keys = catalog.flatMap((t) =>
      Object.entries(t.packages).flatMap(([ecosystem, names]) =>
        names.map((name) => JSON.stringify([ecosystem, name])),
      ),
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(catalog.every((t) => categories.includes(t.category))).toBe(true);
    for (const category of categories.filter((c) => c !== "Unknown"))
      expect(catalog.some((t) => t.category === category)).toBe(true);
  });
  it("groups core, testing, build and data with evidence rather than usage scores", () => {
    const result = stackDNA([
      record("example/web", {
        "package.json": JSON.stringify({
          engines: { node: ">=22" },
          dependencies: { react: "1", pg: "1", mongodb: "1" },
          devDependencies: {
            vitest: "1",
            "@playwright/test": "1",
            "@testing-library/react": "1",
            vite: "1",
          },
        }),
      }),
      record(
        "example/native",
        { "Cargo.toml": '[dependencies]\nserde="1"' },
        { language: "Rust" },
      ),
    ]);
    const group = (name) =>
      result.groups
        .find((g) => g.name === name)
        .technologies.map((t) => t.name);
    expect(group("Core")).toEqual(["Rust", "React", "Node.js"]);
    expect(group("Testing")).toEqual(["Playwright", "RTL", "Vitest"]);
    expect(group("Build")).toEqual(["Vite"]);
    expect(group("Data")).toEqual(["MongoDB", "PostgreSQL"]);
    expect(
      result.technologies.find((t) => t.id === "postgresql").evidence[0],
    ).toMatchObject({
      dependency: "pg",
      repository: "example/web",
      kind: "runtime",
    });
    expect(
      result.technologies.find((t) => t.id === "rust").evidence[0].source,
    ).toBe("GitHub primary language");
    expect(result).not.toHaveProperty("score");
  });
  it("does not infer runtimes, CI, database vendors or parent frameworks from generic evidence", () => {
    const result = stackDNA([
      record("example/app", {
        "package.json":
          '{"dependencies":{"@testing-library/react":"1","vite":"1","@prisma/client":"1"}}',
        "Cargo.toml": '[dependencies]\nsqlx="1"',
      }),
    ]);
    expect(names(result)).not.toContain("React");
    expect(names(result)).not.toContain("Node.js");
    expect(names(result)).not.toContain("Rust");
    expect(names(result)).not.toContain("PostgreSQL");
    expect(names(result)).not.toContain("GitHub Actions");
    expect(names(result)).toContain("SQLx");
  });
  it("uses exact ecosystem identities and leaves unknown packages explicit", () => {
    expect(
      technologyForDependency({ ecosystem: "node", name: "react" }).id,
    ).toBe("react");
    for (const dependency of [
      { ecosystem: "node", name: "reactish" },
      { ecosystem: "python", name: "react" },
      { ecosystem: "node", name: "@unknown/react" },
    ])
      expect(technologyForDependency(dependency).category).toBe("Unknown");
    const result = stackDNA([
      record("example/app", {
        "package.json": '{"dependencies":{"unlisted-tool":"1"}}',
      }),
    ]);
    expect(result.groups[0].name).toBe("Unknown");
    expect(result.technologies[0]).toMatchObject({
      name: "unlisted-tool",
      ecosystem: "node",
      category: "Unknown",
    });
  });
  it("merges technology aliases and ecosystems without losing repository/kind associations", () => {
    const result = stackDNA([
      record("example/one", {
        "package.json":
          '{"dependencies":{"react":"1","react-dom":"1"},"devDependencies":{"react":"1","playwright":"1","@playwright/test":"1"}}',
      }),
      record("example/two", {
        "pyproject.toml": '[project]\ndependencies=["playwright"]',
      }),
    ]);
    expect(
      result.technologies.filter((t) => t.name === "Playwright"),
    ).toHaveLength(1);
    const playwright = result.technologies.find((t) => t.id === "playwright");
    expect(playwright.repositories).toEqual(["example/one", "example/two"]);
    expect(playwright.kinds).toEqual(["development", "runtime"]);
    expect(playwright.evidence).toHaveLength(3);
    expect(
      result.technologies.find((t) => t.id === "react").evidence,
    ).toHaveLength(3);
  });
  it("retains dependency categories independent of dependency kind", () => {
    const result = stackDNA([
      record("example/app", {
        "package.json":
          '{"devDependencies":{"react":"1","tailwindcss":"1","zustand":"1","axios":"1","vercel":"1","lodash":"1"}}',
        "Cargo.toml": '[build-dependencies]\nwasm-bindgen="1"',
      }),
    ]);
    const expected = {
      React: "Framework",
      "Tailwind CSS": "Styling",
      Zustand: "State Management",
      Axios: "API",
      "Vercel CLI": "Deployment",
      Lodash: "Utility",
      "wasm-bindgen": "WebAssembly",
    };
    for (const item of result.technologies)
      expect(item.category).toBe(expected[item.name]);
  });
  it("keeps failed scans out of detection and exposes partial coverage", () => {
    const valid = record(
      "example/good",
      { "package.json": '{"dependencies":{"react":"1"}}' },
      { status: "partial" },
    );
    const bad = {
      ...valid,
      repository: "example/bad",
      status: "failed",
      language: "Rust",
    };
    const result = stackDNA([bad, valid]);
    expect(result).toMatchObject({ assessed: 1, failed: 1, partial: 1 });
    expect(names(result)).toEqual(["React"]);
  });
  it("engine declarations are explicit and their values never execute", () => {
    const manifest = analyzeManifest(
      "package.json",
      JSON.stringify({
        engines: {
          node: "$(touch nope)",
          bun: ">=1",
          deno: "2",
          arbitrary: "Node.js",
        },
        scripts: { start: "node main.js" },
      }),
    );
    expect(manifest.signals.map((s) => s.id)).toEqual([
      "nodejs",
      "bun",
      "deno",
    ]);
    expect(
      analyzeManifest(
        "package.json",
        '{"engines":{"node":true},"scripts":{"start":"node main.js"}}',
      ).signals,
    ).toEqual([]);
  });
  it.each([100, 500, 1000])(
    "is deterministic and bounds evidence for %i repository results",
    (count) => {
      const records = Array.from({ length: count }, (_, i) =>
        record("example/r" + i, {
          "package.json": '{"dependencies":{"react":"1","react-dom":"1"}}',
        }),
      );
      const forward = stackDNA(records),
        backward = stackDNA([...records].reverse());
      expect(backward).toEqual(forward);
      expect(forward.technologies).toHaveLength(1);
      expect(forward.technologies[0].repositories).toHaveLength(count);
      expect(forward.technologies[0].evidence).toHaveLength(100);
      expect(forward.technologies[0].moreEvidence).toBe(true);
    },
  );
  it("does not mutate normalized inputs", () => {
    const input = [
      record("example/app", {
        "package.json": '{"dependencies":{"react":"1","mystery":"1"}}',
      }),
    ];
    const before = JSON.stringify(input);
    stackDNA(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});
