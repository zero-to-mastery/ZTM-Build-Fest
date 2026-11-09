import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  exportPack,
  validatePack,
  importPack,
  packCollisions,
  packChoices,
  packItems,
  packTrustReview,
} from "../src/snippets/pack-schema.js";
import {
  renderExtension,
  validateExtensionManifest,
} from "../src/extensions/manifest.js";
import { examplePacks } from "../src/snippets/example-packs.js";
import { emptyComponents } from "../src/components-library/storage.js";
import { starterCollection } from "../src/badges/collections.js";
const snippet = (name = "Mine", id = "mine") => ({
  version: 1,
  id,
  name,
  category: "Utilities",
  description: "Exact source",
  kind: "custom",
  fields: [],
  tags: [],
  template: "\ufeff# Raw\r\n<script>alert(1)</script>\n{{x}}",
});
const current = () => ({
  componentLibrary: { ...emptyComponents(), snippets: [snippet()] },
  badgeCollections: { version: 1, items: [] },
});
it("round trips valid pack metadata, exact raw source and badge collections", () => {
  const pack = exportPack(
    {
      name: "Kit",
      description: "Useful",
      author: "Ada",
      homepage: "https://example.com",
      license: "MIT",
    },
    [snippet()],
    [starterCollection("Frontend")],
  );
  expect(validatePack(JSON.stringify(pack))).toEqual(pack);
  expect(pack.snippets[0].template).toBe(snippet().template);
  expect(pack.version).toBe(2);
});
it("migrates the version-1 fixture without changing reusable source", () => {
  const raw = readFileSync("tests/fixtures/snippet-packs/v1.json", "utf8");
  const pack = validatePack(raw);
  expect(pack.version).toBe(2);
  expect(pack.migratedFrom).toBe(1);
  expect(pack.snippets[0].template).toBe("# Legacy\r\n\r\nExact source.\n");
  expect(pack.extensions).toEqual([]);
});
it("validates declarative capabilities and renders extension templates without executing code", () => {
  globalThis.extensionExecuted = false;
  const manifest = validateExtensionManifest({
    version: 1,
    type: "readme-studio-extension-manifest",
    name: "Release notes",
    publisher: { name: "Ada", url: "https://example.com/extensions" },
    capabilities: ["render-markdown", "field-input", "external-media"],
    entries: [
      {
        ...snippet("Release card", "release-card"),
        template:
          '## {{title}}\n\n<img src="https://cdn.example.com/release.svg" alt="Release">',
        kind: "structured",
        fields: [
          {
            key: "title",
            label: "Release title",
            type: "text",
            context: "markdown",
            default: "Stable",
          },
        ],
      },
    ],
  });
  expect(renderExtension(manifest, "release-card", { title: "1.0" })).toBe(
    '## 1.0\n\n<img src="https://cdn.example.com/release.svg" alt="Release">',
  );
  expect(globalThis.extensionExecuted).toBe(false);
  expect(manifest.entries[0].external).toBe(true);
  delete globalThis.extensionExecuted;
});
it("allows text fields in Markdown link titles without treating them as URL sinks", () => {
  expect(() =>
    validateExtensionManifest({
      version: 1,
      type: "readme-studio-extension-manifest",
      name: "Link title",
      publisher: { name: "Ada", url: "https://example.com/extensions" },
      capabilities: ["render-markdown", "field-input", "external-media"],
      entries: [
        {
          ...snippet("Docs", "docs"),
          kind: "structured",
          template: '[Docs](https://example.com "{{caption}}")',
          fields: [
            {
              key: "caption",
              label: "Caption",
              type: "text",
              context: "markdown",
              default: "Documentation",
            },
          ],
        },
      ],
    }),
  ).not.toThrow();
});
it("allows inert prose and code examples that mention blocked syntax", () => {
  for (const template of [
    "## Data: results",
    "Use `data:` only when documenting a URI scheme.",
    "```html\n<script>alert(1)</script>\n```",
    "Show &lt;script&gt; as escaped text.",
  ])
    expect(() =>
      validateExtensionManifest({
        version: 1,
        type: "readme-studio-extension-manifest",
        name: "Documentation",
        publisher: { name: "Ada", url: "https://example.com/extensions" },
        capabilities: ["render-markdown"],
        entries: [{ ...snippet("Example", "example"), template }],
      }),
    ).not.toThrow();
});
it.each([
  "http:evil.example/x.svg",
  "http:/evil.example/x.svg",
  "https:\\\\evil.example\\x.svg",
])("requires external-media for browser-normalized URL %s", (url) => {
  const raw = {
    version: 1,
    type: "readme-studio-extension-manifest",
    name: "Remote image",
    publisher: { name: "Ada", url: "https://example.com/extensions" },
    capabilities: ["render-markdown"],
    entries: [
      { ...snippet("Remote", "remote"), template: `![remote](${url})` },
    ],
  };
  expect(() => validateExtensionManifest(raw)).toThrow(/external-media/);
  raw.capabilities.push("external-media");
  const pack = validatePack({
    version: 2,
    type: "readme-studio-snippet-pack",
    name: "Remote",
    snippets: [],
    extensions: [raw],
  });
  expect(packTrustReview(pack).externalUrls).toContain(
    url.startsWith("http:")
      ? "http://evil.example/x.svg"
      : "https://evil.example/x.svg",
  );
});
it("rejects credential-bearing external URL sinks", () => {
  expect(() =>
    validateExtensionManifest({
      version: 1,
      type: "readme-studio-extension-manifest",
      name: "Credential URL",
      publisher: { name: "Ada", url: "https://example.com/extensions" },
      capabilities: ["render-markdown", "external-media"],
      entries: [
        {
          ...snippet("Remote", "remote"),
          template: "![remote](https://user:secret@evil.example/x.svg)",
        },
      ],
    }),
  ).toThrow(/cannot include executable markup or URLs/);
});
it("rejects event handlers wrapped by backticks inside raw HTML attributes", () => {
  expect(() =>
    validateExtensionManifest({
      version: 1,
      type: "readme-studio-extension-manifest",
      name: "Attribute backticks",
      publisher: { name: "Ada", url: "https://example.com/extensions" },
      capabilities: ["render-markdown"],
      entries: [
        {
          ...snippet("Hostile", "hostile"),
          template: '<img alt="`" onerror="alert(1)" title="`">',
        },
      ],
    }),
  ).toThrow(/cannot include executable markup or URLs/);
});
it("rejects event handlers after greater-than characters in quoted attributes", () => {
  expect(() =>
    validateExtensionManifest({
      version: 1,
      type: "readme-studio-extension-manifest",
      name: "Quoted greater-than",
      publisher: { name: "Ada", url: "https://example.com/extensions" },
      capabilities: ["render-markdown"],
      entries: [
        {
          ...snippet("Hostile", "hostile"),
          template: '<img alt=">" onerror="alert(1)">',
        },
      ],
    }),
  ).toThrow(/cannot include executable markup or URLs/);
});
it("keeps an unsafe result when benign HTML tokens follow it", () => {
  expect(() =>
    validateExtensionManifest({
      version: 1,
      type: "readme-studio-extension-manifest",
      name: "Multiple HTML tokens",
      publisher: { name: "Ada", url: "https://example.com/extensions" },
      capabilities: ["render-markdown"],
      entries: [
        {
          ...snippet("Hostile", "hostile"),
          template: "<script>alert(1)</script>\n\n<span>safe</span>",
        },
      ],
    }),
  ).toThrow(/cannot include executable markup or URLs/);
});
it.each([
  { version: 2 },
  { capabilities: ["network-request"] },
  { publisher: { name: "Unknown", url: "http://example.com" } },
  { script: "globalThis.extensionExecuted = true" },
  { module: "https://example.com/plugin.js" },
  {
    entries: [
      {
        ...snippet(),
        template: "[run](javascript:alert(1))",
      },
    ],
  },
  {
    entries: [
      {
        ...snippet(),
        template: '<img src="java&#x73;cript:alert(1)">',
      },
    ],
  },
  {
    entries: [
      {
        ...snippet(),
        template: '<a href="java&#x09;script:alert(1)">run</a>',
      },
    ],
  },
  {
    entries: [
      {
        ...snippet(),
        template: "![payload](data:image/svg+xml,<svg/onload=alert(1)>)",
      },
    ],
  },
  {
    entries: [
      {
        ...snippet(),
        template: "![remote](//cdn.example.com/card.svg)",
      },
    ],
  },
  {
    entries: [
      {
        ...snippet(),
        template:
          '<img src="https&colon;&sol;&sol;cdn.example.com/encoded.svg">',
      },
    ],
  },
  {
    capabilities: ["render-markdown", "field-input"],
    entries: [
      {
        ...snippet(),
        kind: "structured",
        template: "![remote]({{url}})",
        fields: [
          {
            key: "url",
            label: "Image URL",
            type: "url",
            context: "url",
            default: "https://cdn.example.com/default.svg",
          },
        ],
      },
    ],
  },
  {
    entries: [
      {
        ...snippet(),
        kind: "structured",
        template: "## {{title}}",
        fields: [
          {
            key: "title",
            label: "Title",
            type: "text",
            context: "markdown",
            default: "Safe",
          },
        ],
      },
    ],
  },
  {
    capabilities: ["render-markdown", "field-input"],
    entries: [
      {
        ...snippet(),
        kind: "structured",
        template: "![remote]({{value}})",
        fields: [
          {
            key: "value",
            label: "Value",
            type: "text",
            context: "markdown",
            default: "",
          },
        ],
      },
    ],
  },
])("rejects executable or unsafe extension entries", (override) =>
  expect(() =>
    validateExtensionManifest({
      version: 1,
      type: "readme-studio-extension-manifest",
      name: "Unsafe",
      publisher: { name: "Unknown", url: "https://example.com" },
      capabilities: ["render-markdown"],
      entries: [{ ...snippet(), template: "## Safe" }],
      ...override,
    }),
  ).toThrow(),
);
it("surfaces provenance, capabilities and every external URL before importing extensions", () => {
  const pack = validatePack({
    version: 2,
    type: "readme-studio-snippet-pack",
    name: "Trusted kit",
    author: "Ada",
    homepage: "https://example.com/kit",
    snippets: [
      {
        ...snippet("Links", "links"),
        template:
          "[Docs](https://docs.example.com/start) ![Logo](https://img.example.com/logo.svg)",
        attribution: { name: "Source", url: "https://source.example.com" },
      },
    ],
    extensions: [
      {
        version: 1,
        type: "readme-studio-extension-manifest",
        name: "Cards",
        publisher: { name: "Ada", url: "https://example.com/extensions" },
        capabilities: ["render-markdown"],
        entries: [{ ...snippet("Card", "card"), template: "## Card" }],
      },
    ],
  });
  const review = packTrustReview(pack, {
    source: "trusted.snippets.json",
  });
  expect(review.provenance).toEqual({
    source: "trusted.snippets.json",
    author: "Ada",
    homepage: "https://example.com/kit",
  });
  expect(review.capabilities).toEqual(["render-markdown"]);
  expect(review.publishers).toEqual([
    { name: "Ada", url: "https://example.com/extensions" },
  ]);
  expect(review.externalUrls).toEqual([
    "https://docs.example.com/start",
    "https://example.com/extensions",
    "https://example.com/kit",
    "https://img.example.com/logo.svg",
    "https://source.example.com/",
  ]);
  expect(packItems(pack)).toHaveLength(2);
  expect(importPack({}, pack).componentLibrary.snippets).toHaveLength(2);
});
it("lists generated and custom badge collection URLs in the trust review", () => {
  const collection = starterCollection("Social");
  collection.style = "pictures";
  collection.badges.push({
    name: "Hosted badge",
    alt: "Hosted badge",
    lightUrl: "https://light.example.com/badge.svg",
    darkUrl: "https://dark.example.com/badge.svg",
    link: "https://target.example.com",
  });
  const review = packTrustReview(
    exportPack({ name: "Badges" }, [], [collection]),
  );
  expect(review.externalUrls).toEqual(
    expect.arrayContaining([
      "https://dark.example.com/badge.svg",
      "https://light.example.com/badge.svg",
      "https://target.example.com/",
    ]),
  );
  expect(
    review.externalUrls.some((url) =>
      url.startsWith("https://img.shields.io/"),
    ),
  ).toBe(true);
});
it("decodes external URLs before capability enforcement and trust review", () => {
  const pack = validatePack({
    version: 2,
    type: "readme-studio-snippet-pack",
    name: "Encoded URL",
    snippets: [],
    extensions: [
      {
        version: 1,
        type: "readme-studio-extension-manifest",
        name: "Encoded media",
        publisher: { name: "Ada", url: "https://example.com/extensions" },
        capabilities: ["render-markdown", "external-media"],
        entries: [
          {
            ...snippet("Encoded", "encoded"),
            template:
              '<img src="https&colon;&sol;&sol;cdn.example.com/encoded.svg">',
          },
        ],
      },
    ],
  });
  expect(packTrustReview(pack).externalUrls).toContain(
    "https://cdn.example.com/encoded.svg",
  );
});
it("keeps hostile filenames inert without rejecting an otherwise safe pack", () => {
  const review = packTrustReview(exportPack({ name: "Safe" }, [snippet()]), {
    source: "<img onerror=alert(1)>.json",
  });
  expect(review.provenance.source).toBe("�img onerror=alert(1)�.json");
});
it.each([
  {
    version: 3,
    type: "readme-studio-snippet-pack",
    name: "Future",
    snippets: [],
  },
  {
    version: 1,
    type: "readme-studio-snippet-pack",
    name: "Mis-versioned extensions",
    snippets: [],
    extensions: [],
  },
  { version: 1, type: "wrong", name: "Wrong", snippets: [] },
  {
    version: 1,
    type: "readme-studio-snippet-pack",
    name: "<img onerror=evil>",
    snippets: [],
  },
  {
    version: 1,
    type: "readme-studio-snippet-pack",
    name: "Bad URL",
    homepage: "javascript:evil",
    snippets: [],
  },
  { version: 1, type: "readme-studio-snippet-pack", name: "Missing" },
  {
    version: 1,
    type: "readme-studio-snippet-pack",
    name: "Unknown type",
    snippets: [{ ...snippet(), kind: "script" }],
  },
])("rejects malformed/future packs and malicious metadata", (raw) =>
  expect(() => validatePack(raw)).toThrow(),
);
it("default Keep both changes colliding IDs and deterministic names", () => {
  const result = importPack(
    current(),
    exportPack({ name: "Kit" }, [snippet()]),
  );
  expect(result.componentLibrary.snippets.map((c) => c.name)).toEqual([
    "Mine",
    "Mine (2)",
  ]);
  expect(result.componentLibrary.snippets[1].id).not.toBe("mine");
});
it("Replace preserves matched identity and Skip keeps existing values", () => {
  const pack = exportPack({ name: "Kit" }, [
    { ...snippet(), template: "updated" },
  ]);
  expect(
    importPack(current(), pack, "replace").componentLibrary.snippets[0]
      .template,
  ).toBe("updated");
  expect(
    importPack(current(), pack, "replace").componentLibrary.snippets[0].id,
  ).toBe("mine");
  expect(importPack(current(), pack, "skip").componentLibrary.snippets).toEqual(
    current().componentLibrary.snippets.map(
      (c) => validatePack(exportPack({ name: "Kit" }, [c])).snippets[0],
    ),
  );
});
it("handles name collisions case-insensitively and rejects ambiguous replacement", () => {
  const data = current();
  data.componentLibrary.snippets.push(snippet("Second", "second"));
  const pack = exportPack({ name: "Kit" }, [snippet("SECOND", "mine")]);
  expect(packCollisions(data, pack)[0].matches).toHaveLength(2);
  expect(() => importPack(data, pack, "replace")).toThrow(
    "different IDs/names",
  );
  expect(importPack(data, pack, "keep").componentLibrary.snippets).toHaveLength(
    3,
  );
});
it("resolves collisions within a pack and never overwrites built-ins", () => {
  const pack = exportPack({ name: "Kit" }, [
    snippet("A", "builtin:example"),
    snippet("A", "builtin:example"),
  ]);
  const result = importPack({}, pack);
  expect(result.componentLibrary.snippets.map((c) => c.name)).toEqual([
    "A",
    "A (2)",
  ]);
  expect(
    result.componentLibrary.snippets.every((c) => !c.id.startsWith("builtin:")),
  ).toBe(true);
});
it("example packs are editable definitions and current project source can be exported", () => {
  expect(examplePacks).toHaveLength(4);
  for (const pack of examplePacks)
    expect(validatePack(pack).snippets.length).toBeGreaterThan(0);
  const choices = packChoices(
    {},
    {
      blocks: [
        { id: "raw", type: "custom", settings: { markdown: "EXACT\r\n" } },
      ],
    },
  );
  expect(choices[0].component.template).toBe("EXACT\r\n");
});
it("badge collection collisions follow Keep both, Replace and Skip", () => {
  const c = starterCollection("Frontend"),
    data = { badgeCollections: { version: 1, items: [c] } },
    p = exportPack({ name: "Badges" }, [], [c]);
  expect(importPack(data, p).badgeCollections.items).toHaveLength(2);
  expect(importPack(data, p, "replace").badgeCollections.items).toHaveLength(1);
  expect(importPack(data, p, "skip").badgeCollections.items).toHaveLength(1);
});
