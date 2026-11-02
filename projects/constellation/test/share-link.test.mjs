import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeShare,
  encodeShare,
  publicShareBase,
  PUBLIC_STUDIO_URL,
} from "../src/share-link.mjs";
import { randomizeDesign } from "../src/design-randomizer.mjs";
import { defaultVisualStyle } from "../src/visual-style.mjs";

test("readable parameters select personal, organization, and focused organization views", () => {
  const personal = decodeShare(
    "https://example.test/?user=octocat&arrangement=solar-system&maxRepos=25&animate=false&seed=my-sky",
  );
  assert.equal(personal.account, "octocat");
  assert.equal(personal.options.arrangement, "solar-system");
  assert.equal(personal.options.maxRepos, 25);
  assert.equal(personal.options.animate, false);
  assert.equal(personal.options.seedMode, "custom");
  const light = decodeShare("https://example.test/?user=octocat&theme=light");
  assert.equal(light.options.theme, "light");
  assert.equal(
    light.options.visualTheme,
    undefined,
    "a color mode overrides the preset palette",
  );
  const org = decodeShare(
    "https://example.test/?organization=collective&preset=organization-technology",
  );
  assert.equal(org.account, "collective");
  assert.equal(org.options.accountType, "organization");
  assert.equal(org.options.organizationView, "technology");
  const pair = decodeShare(
    "https://example.test/?user=alice&organization=collective",
  );
  assert.equal(pair.account, "collective");
  assert.equal(pair.options.organizationUser, "alice");
  assert.equal(pair.options.organizationView, "collaboration");
});

test("design codes and direct parameters override shared settings in documented order", () => {
  const code = "v5:m000-y2026-f2018-share-test";
  const direct = decodeShare(
    `https://example.test/?user=octocat&design=${code}`,
  );
  assert.deepEqual(direct.options, randomizeDesign(code));
  const link = new URL(
    encodeShare("https://example.test", "octocat", {
      maxRepos: 45,
      nodeMode: "combined",
    }),
  );
  link.searchParams.set("maxRepos", "12");
  assert.equal(decodeShare(link.href).options.maxRepos, 12);
  assert.equal(decodeShare(link.href).options.nodeMode, "combined");
  link.searchParams.set("preset", "minimal-readme");
  assert.equal(decodeShare(link.href).options.layout, "compact");
  assert.equal(decodeShare(link.href).options.maxRepos, 12);
});

test("invalid parameters cannot silently restore a different view", () => {
  for (const query of [
    "user=octocat&maxRepos=-1",
    "user=octocat&maxRepos=101",
    "user=octocat&maxRepos=NaN",
    "user=octocat&animate=maybe",
    "user=octocat&user=alice",
    "user=octocat&preset=missing",
    "user=octocat&design=broken",
    "user=octocat&arrangement=missing",
    "preset=project-map",
  ]) {
    assert.throws(() => decodeShare(`https://example.test/?${query}`), query);
  }
});

test("generated links retain edits, omit runtime secrets, and use a public base from local preview", () => {
  const options = {
    accountType: "organization",
    organizationUser: "alice",
    visualStyle: defaultVisualStyle(),
    css: ".star{opacity:.3}",
    customCSS: ".star{opacity:.6}",
    starPositions: { "collective/demo": { x: 120, y: 100 } },
    labelOffsets: { "collective/demo": { x: 2, y: 15 } },
    token: "secret",
    organizationData: { records: { private: true } },
  };
  const link = encodeShare(
    publicShareBase("http://127.0.0.1:4173/?token=secret"),
    "collective",
    options,
  );
  assert.ok(link.startsWith(PUBLIC_STUDIO_URL));
  const decoded = decodeShare(link);
  assert.equal(decoded.options.customCSS, options.customCSS);
  assert.equal(decoded.options.css, undefined);
  assert.deepEqual(decoded.options.starPositions, options.starPositions);
  assert.deepEqual(decoded.options.labelOffsets, options.labelOffsets);
  assert.equal(decoded.options.token, undefined);
  assert.equal(decoded.options.organizationData, undefined);
  assert.equal(publicShareBase("http://localhost:4173/"), PUBLIC_STUDIO_URL);
  assert.equal(publicShareBase("http://[::1]:4173/"), PUBLIC_STUDIO_URL);
  assert.equal(
    publicShareBase("https://example.test/studio/"),
    "https://example.test/studio/",
  );
});

test("Developer Topology emphasis survives config and share-link round trips", () => {
  const options = { arrangement: "profile", profileEmphasis: "systems" };
  const decoded = decodeShare(
    encodeShare("https://example.test", "octocat", options),
  );
  assert.equal(decoded.options.arrangement, "profile");
  assert.equal(decoded.options.profileEmphasis, "systems");
  assert.throws(() =>
    decodeShare("https://example.test/?user=octocat&profileEmphasis=resume"),
  );
});
