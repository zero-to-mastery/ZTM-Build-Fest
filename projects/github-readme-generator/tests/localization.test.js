import { describe, expect, it } from "vitest";
import {
  languageAwareness,
  LOCALIZATION_SOURCE_LIMIT,
  localizationCollision,
  localizationSettings,
  sourceSnapshot,
  translationReview,
  validateLocalization,
} from "../src/localization/model.js";
import {
  createBackup,
  recoverWorkspace,
  restoreWorkspace,
  validateWorkspace,
} from "../src/state/workspace-backup.js";
import { createProject, inspectProject } from "../src/studio-projects/model.js";
import { sourceDigest } from "../src/state/source-digest.js";
import { analyzeDraft } from "../src/markdown/health-analysis.js";

const draft = (id, markdown, localization, path = `${id}.md`) => ({
  id,
  name: id,
  markdown,
  blocks: [{ id: `${id}-block`, type: "custom", settings: { markdown } }],
  metadata: {
    workspaceDocument: {
      version: 1,
      kind: "repository",
      target: { repository: "owner/repo", branch: "main", path },
      ...(localization ? { localization } : {}),
    },
  },
  updated: 1,
});

describe("localized document metadata", () => {
  it("uses deterministic SHA-256 digests for exact UTF-8 source bytes", () => {
    expect(sourceDigest("")).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sourceDigest("abc")).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sourceDigest("é")).not.toBe(sourceDigest("e"));
    expect(() =>
      sourceSnapshot("x".repeat(LOCALIZATION_SOURCE_LIMIT)),
    ).not.toThrow();
    expect(() =>
      sourceSnapshot("x".repeat(LOCALIZATION_SOURCE_LIMIT + 1)),
    ).toThrow(/1 MB/);
  });
  it("maps locale, source revision and explicit target without changing source", () => {
    const source = draft("source", "# Project\n\n## Usage\n\nRun.\n");
    const localization = localizationSettings("es", source);
    const translated = draft(
      "translation",
      "# Proyecto\n\n## Uso\n\nEjecutar.\n",
      localization,
      "docs/es/README.md",
    );
    expect(validateLocalization(localization).sourceDocumentId).toBe("source");
    expect(localization.source.revision).toBe(
      sourceSnapshot(source.markdown).revision,
    );
    expect(translated.markdown).toBe("# Proyecto\n\n## Uso\n\nEjecutar.\n");
  });

  it("rejects target and language-edition collisions", () => {
    const source = draft(
      "source",
      "# Project\n",
      localizationSettings("en", null, "# Project\n"),
      "README.md",
    );
    const spanish = draft(
      "spanish",
      "# Proyecto\n",
      localizationSettings("es", source),
      "docs/es/README.md",
    );
    expect(
      localizationCollision([source, spanish], "new", {
        target: {
          repository: "owner/repo",
          branch: "main",
          path: "docs/es/README.md",
        },
        localization: localizationSettings("fr", source),
      }),
    ).toContain("repository, branch and path");
    expect(
      localizationCollision([source, spanish], "new", {
        target: {
          repository: "owner/repo",
          branch: "main",
          path: "docs/es-2/README.md",
        },
        localization: localizationSettings("es", source),
      }),
    ).toContain("already has an edition");
    expect(
      localizationCollision([source], "new", {
        target: null,
        localization: localizationSettings("en", null, "# Other\n"),
      }),
    ).toBe("");
    expect(() => localizationSettings("fr", spanish)).toThrow("source edition");
  });

  it("round-trips localized metadata in backup while Markdown remains exact", () => {
    const source = draft(
      "source",
      "# Project\r\n",
      localizationSettings("en", null, "# Project\r\n"),
      "README.md",
    );
    const translated = draft(
      "translation",
      "# Proyecto\r\n",
      localizationSettings("es", source),
      "docs/es/README.md",
    );
    const data = {
      version: 1,
      drafts: [source, translated],
      active: translated.id,
      settings: {},
    };
    const restored = validateWorkspace(createBackup(data));
    expect(restored.drafts[1].markdown).toBe("# Proyecto\r\n");
    expect(restored.drafts[1].metadata.workspaceDocument.localization).toEqual({
      ...translated.metadata.workspaceDocument.localization,
      sourceDocumentId: restored.drafts[0].id,
    });
  });

  it("rejects malformed, future and translation-chain metadata at portable boundaries", () => {
    const source = draft("source", "# Source\n");
    const translated = draft(
      "translation",
      "# Traducción\n",
      localizationSettings("es", source),
    );
    translated.metadata.workspaceDocument.localization.version = 2;
    const future = {
      version: 1,
      drafts: [source, translated],
      active: translated.id,
      settings: {},
    };
    expect(() => validateWorkspace(future)).toThrow(/unreadable/);
    const project = createProject(
      draft("portable", "# Portable\n", localizationSettings("es", source)),
    );
    project.document.metadata.workspaceDocument.localization.version = 2;
    expect(inspectProject(project).mode).toBe("recovery");

    const dependent = draft(
      "dependent",
      "# Dependent\n",
      localizationSettings("fr", source),
    );
    source.metadata.workspaceDocument.localization = localizationSettings(
      "en",
      draft("upstream", "# Upstream\n"),
    );
    expect(() =>
      validateWorkspace({
        version: 1,
        drafts: [source, dependent],
        active: dependent.id,
        settings: {},
      }),
    ).toThrow(/missing source|another translation/);
  });

  it("keeps unresolved standalone translations usable and rejects graph collisions", () => {
    const unresolved = draft(
      "translation",
      "# Traducción\n",
      localizationSettings("es", draft("missing", "# Missing\n")),
    );
    expect(
      validateWorkspace({
        version: 1,
        drafts: [unresolved],
        active: unresolved.id,
        settings: {},
      }).drafts[0].metadata.workspaceDocument.localization.sourceDocumentId,
    ).toBe("missing");

    const source = draft("source", "# Source\n", null, "README.md");
    const first = draft(
      "first",
      "# Uno\n",
      localizationSettings("es", source),
      "docs/es/README.md",
    );
    const second = draft(
      "second",
      "# Dos\n",
      localizationSettings("es", source),
      "docs/es-2/README.md",
    );
    expect(() =>
      validateWorkspace({
        version: 1,
        drafts: [source, first, second],
        active: first.id,
        settings: {},
      }),
    ).toThrow(/two editions/i);
    second.metadata.workspaceDocument.localization = localizationSettings(
      "fr",
      source,
    );
    second.metadata.workspaceDocument.target =
      first.metadata.workspaceDocument.target;
    expect(() =>
      validateWorkspace({
        version: 1,
        drafts: [source, first, second],
        active: first.id,
        settings: {},
      }),
    ).toThrow(/same repository/i);

    const current = validateWorkspace({
      version: 1,
      drafts: [first],
      active: first.id,
      settings: {},
    });
    const incoming = validateWorkspace({
      version: 1,
      drafts: [second],
      active: second.id,
      settings: {},
    });
    expect(() => restoreWorkspace(current, incoming, "merge")).toThrow(
      /same repository/i,
    );
  });

  it("recovers readable Markdown while dropping only malformed localization", () => {
    const good = draft("good", "# Good\n");
    const damaged = draft("damaged", "# Still readable\n");
    damaged.metadata.workspaceDocument.localization = {
      version: 99,
      locale: "es",
    };
    const recovered = recoverWorkspace(
      JSON.stringify({
        version: 1,
        drafts: [good, damaged],
        active: damaged.id,
        settings: {},
      }),
    );
    expect(recovered.drafts.map((item) => item.markdown)).toEqual([
      "# Good\n",
      "# Still readable\n",
    ]);
    expect(
      recovered.drafts[1].metadata.workspaceDocument.localization,
    ).toBeUndefined();
  });

  it("opens legacy shared targets and salvages localization graph conflicts", () => {
    const legacyA = draft("legacy-a", "# A\n", null, "README.md");
    const legacyB = draft("legacy-b", "# B\n", null, "README.md");
    const legacy = {
      version: 1,
      drafts: [legacyA, legacyB],
      active: legacyA.id,
      settings: {},
    };
    expect(validateWorkspace(legacy).drafts).toHaveLength(2);
    expect(recoverWorkspace(JSON.stringify(legacy)).drafts).toHaveLength(2);
    const localizedCollision = draft(
      "localized-collision",
      "# Localized\n",
      localizationSettings("fr", null, "# Localized\n"),
      "README.md",
    );
    expect(() =>
      validateWorkspace({
        ...legacy,
        drafts: [...legacy.drafts, localizedCollision],
      }),
    ).toThrow(/localized documents/i);

    const source = draft("source", "# Source\n", null, "README.md");
    const first = draft(
      "first",
      "# Uno\n",
      localizationSettings("es", source),
      "docs/es/README.md",
    );
    const second = draft(
      "second",
      "# Dos\n",
      localizationSettings("es", source),
      "docs/es-2/README.md",
    );
    const otherSource = draft("other-source", "# Other source\n");
    const validLater = draft(
      "valid-later",
      "# Valide\n",
      localizationSettings("fr", otherSource),
      "docs/fr/README.md",
    );
    const recovered = recoverWorkspace(
      JSON.stringify({
        version: 1,
        drafts: [source, first, second, otherSource, validLater],
        active: second.id,
        settings: {},
      }),
    );
    expect(recovered.drafts.map((item) => item.markdown)).toEqual([
      "# Source\n",
      "# Uno\n",
      "# Dos\n",
      "# Other source\n",
      "# Valide\n",
    ]);
    expect(
      recovered.drafts.filter(
        (item) => item.metadata.workspaceDocument.localization,
      ),
    ).toHaveLength(2);
    expect(
      recovered.drafts.find((item) => item.name === "valid-later").metadata
        .workspaceDocument.localization.locale,
    ).toBe("fr");
  });

  it("does not retain removed heading text in portable revision metadata", () => {
    const secret = "Internal acquisition codename";
    const source = draft("source", `# Project\n\n## ${secret}\n\nOld.\n`);
    const translated = draft(
      "translation",
      "# Proyecto\n",
      localizationSettings("es", source),
    );
    source.markdown = "# Project\n";
    source.blocks[0].settings.markdown = source.markdown;
    const portable = JSON.stringify(
      createBackup({
        version: 1,
        drafts: [source, translated],
        active: translated.id,
        settings: {},
      }),
    );
    expect(portable).not.toContain(secret);
    expect(JSON.stringify(createProject(translated))).not.toContain(secret);
  });

  it("rejects converting a source edition while translations depend on it", () => {
    const source = draft("source", "# Source\n");
    const translated = draft(
      "translation",
      "# Traducción\n",
      localizationSettings("es", source),
    );
    const upstream = draft("upstream", "# Upstream\n");
    expect(
      localizationCollision([source, translated, upstream], source.id, {
        target: { repository: "owner/repo", branch: "main", path: "README.md" },
        localization: localizationSettings("en", upstream),
      }),
    ).toContain("linked translations");
  });
});

describe("translation change review", () => {
  it("classifies changed, added, removed and reordered sections conservatively", () => {
    const before = "# Project\n\n## Install\n\nOld.\n\n## Usage\n\nRun.\n";
    const source = draft("source", before);
    const translated = draft(
      "translation",
      "# Proyecto\n",
      localizationSettings("es", source),
    );
    source.markdown =
      "## Usage\n\nRun.\n\n# Project\n\n## Install\n\nNew.\n\n## Help\n\nAsk.\n";
    const review = translationReview(source, translated);
    expect(review.changed).toBe(true);
    expect(review.findings.map((item) => item.status)).toEqual(
      expect.arrayContaining(["changed", "added", "reordered"]),
    );
    source.markdown = "# Project\n\n## Usage\n\nRun.\n";
    expect(
      translationReview(source, translated).findings.some(
        (item) => item.status === "removed",
      ),
    ).toBe(true);
  });

  it("marks repeated section identities unknown instead of guessing", () => {
    const source = draft("source", "# Project\n\n## Usage\n\nOne.\n");
    const translated = draft(
      "translation",
      "# Proyecto\n",
      localizationSettings("es", source),
    );
    source.markdown = "# Project\n\n## Usage\n\nOne.\n\n## Usage\n\nTwo.\n";
    const findings = translationReview(source, translated).findings;
    expect(findings.find((item) => item.status === "unknown").title).toBe(
      "Usage",
    );
  });
});

describe("multilingual analysis fixtures", () => {
  const fixtures = [
    ["en", "# Project\n\n## Usage\n"],
    ["es", "# Proyecto\n\n## Uso\n"],
    ["fr", "# Projet\n\n## Utilisation\n"],
    ["de", "# Projekt\n\n## Verwendung\n"],
    ["pt-BR", "# Projeto\n\n## Uso\n"],
    ["ja", "# プロジェクト\n\n## 使い方\n"],
    ["zh-CN", "# 项目\n\n## 用法\n"],
    ["ko", "# 프로젝트\n\n## 사용법\n"],
  ];

  it.each(fixtures)(
    "keeps %s structural checks available",
    (locale, source) => {
      const review = languageAwareness(locale, source);
      expect(review.structural[0].status).toBe("observed");
      expect(review.languageSensitive.status).toBe(
        locale === "en" ? "available" : "unknown",
      );
    },
  );

  it("makes non-English wording checks Unknown in actual README Health", () => {
    const localized = draft(
      "spanish",
      "# Proyecto\n\n![image](demo.png)\n",
      localizationSettings("es", null, "# Proyecto\n"),
    );
    const { analysis } = analyzeDraft(localized);
    expect(analysis.languageAwareness).toMatchObject({
      locale: "es",
      status: "unknown",
    });
    expect(
      analysis.detail.issues.some(
        (issue) => issue.ruleId === "image-alt-quality",
      ),
    ).toBe(false);
  });
});
