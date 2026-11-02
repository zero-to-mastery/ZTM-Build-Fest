import { describe, expect, it } from "vitest";
import { serializeBlocks } from "../src/markdown/serialize.js";
import { Store } from "../src/state/store.js";
import {
  authorRepositories,
  repositoryContext,
} from "../src/github/repository-context.js";
import {
  applyOwnershipReview,
  ownershipReviewForEdit,
  ownershipReviewForRecord,
} from "../src/markdown/ownership-review.js";

const hero = (subtitle = "Original") => ({
  id: "hero-1",
  type: "hero",
  settings: { name: "Ada", subtitle },
});
const detached = (markdown = "<h1>Ada</h1>\n\nChanged by hand") => ({
  id: "custom-1",
  type: "custom",
  settings: { markdown },
  separator: "\r\n\r\n",
});
const record = (previous = hero()) => ({
  version: 1,
  id: "record-1",
  blockId: "custom-1",
  previousBlockIds: [previous.id],
  labels: ["Ada"],
  kinds: ["builder"],
  at: "2026-10-22T00:00:00.000Z",
  previous,
});
const draft = (blocks, metadata = {}) => ({
  id: "draft-1",
  name: "Draft",
  blocks,
  metadata,
  markdown: serializeBlocks(blocks),
  updated: 0,
});

describe("ownership review", () => {
  it("does not interrupt a visual edit while its source remains current", () => {
    const opened = hero();
    expect(
      ownershipReviewForEdit(
        draft([structuredClone(opened)]),
        opened,
        hero("Proposed"),
      ),
    ).toBeNull();
  });

  it("reviews a detached block and restores only that visual version", () => {
    const current = detached();
    const d = draft(
      [current, { id: "tail", type: "custom", settings: { markdown: "Tail" } }],
      {
        detachments: [record(), { bad: true }],
      },
    );
    const plan = ownershipReviewForEdit(d, hero(), hero("Proposed"));
    expect(plan).toMatchObject({
      targetBlockId: "custom-1",
      recordId: "record-1",
      label: "Ada",
      original: current.settings.markdown,
    });
    expect(plan.proposed).toContain("Proposed");

    const result = applyOwnershipReview(d, plan);
    expect(result.blocks[0]).toMatchObject({
      id: "hero-1",
      type: "hero",
      separator: "\r\n\r\n",
      settings: { subtitle: "Proposed" },
    });
    expect(result.blocks[1]).toEqual(d.blocks[1]);
    expect(result.metadata.detachments).toEqual([{ bad: true }]);
  });

  it("opens a Restorable record and applies it as one undoable Store edit", () => {
    const current = detached();
    const d = draft([current], { detachments: [record()] });
    const plan = ownershipReviewForRecord(d, "record-1");
    const result = applyOwnershipReview(d, plan);
    const store = new Store(d);
    store.blocks(result.blocks, result.metadata);
    expect(store.draft.blocks[0].type).toBe("hero");
    expect(store.draft.metadata.detachments).toEqual([]);

    store.undo();
    expect(store.draft.blocks).toEqual([current]);
    expect(store.draft.metadata.detachments).toEqual([record()]);
  });

  it("refuses non-Restorable records and targets that changed again", () => {
    const d = draft([detached()], {
      detachments: [{ ...record(), previous: null }],
    });
    expect(() => ownershipReviewForRecord(d, "record-1")).toThrow(
      "not Restorable",
    );

    const restorable = draft([detached()], { detachments: [record()] });
    const plan = ownershipReviewForRecord(restorable, "record-1");
    expect(() =>
      applyOwnershipReview(draft([], { detachments: [record()] }), plan),
    ).toThrow("changed again");
  });

  it("refuses malformed visual copies and duplicate restored identities", () => {
    const malformed = draft([detached()], {
      detachments: [
        record({ id: "hero-1", type: "custom", settings: { markdown: "x" } }),
      ],
    });
    expect(() => ownershipReviewForRecord(malformed, "record-1")).toThrow(
      "invalid visual version",
    );

    const duplicate = draft(
      [detached(), { ...hero(), settings: { name: "Other", subtitle: "" } }],
      { detachments: [record()] },
    );
    const plan = ownershipReviewForRecord(duplicate, "record-1");
    expect(() => applyOwnershipReview(duplicate, plan)).toThrow(
      "conflicts with another section identity",
    );
  });

  it("refuses ambiguous Detachment record identities without removing either record", () => {
    const d = draft([detached()], {
      detachments: [
        record(),
        { ...record(hero("Other visual copy")), blockId: "custom-2" },
      ],
    });
    expect(() => ownershipReviewForRecord(d, "record-1")).toThrow(
      "duplicate identity",
    );
    expect(d.metadata.detachments).toHaveLength(2);
  });

  it.each([
    ["an unknown builder", { ...hero(), type: "surprise" }],
    ["a shared copy", { ...hero(), sharedComponent: "shared-1" }],
    ["a generated copy", { ...hero(), githubGenerated: true }],
    ["a profile copy", { ...hero(), profileIntro: true }],
  ])("refuses %s in untrusted Restorable metadata", (_label, previous) => {
    const d = draft([detached()], { detachments: [record(previous)] });
    expect(() => ownershipReviewForRecord(d, "record-1")).toThrow(
      "invalid visual version",
    );
  });

  it("refuses registry-derived generated project ownership", () => {
    const previous = authorRepositories(
      [
        repositoryContext({
          name: "demo",
          full_name: "ada/demo",
          description: "Generated description",
          homepage: "",
          topics: ["readme"],
          language: "JavaScript",
          default_branch: "main",
          lastFetched: "2026-10-22T00:00:00.000Z",
        }),
      ],
      { action: "projects" },
    );
    delete previous.githubGenerated;
    const d = draft([detached()], { detachments: [record(previous)] });
    expect(() => ownershipReviewForRecord(d, "record-1")).toThrow(
      "invalid visual version",
    );
  });

  it("refuses banner ownership derived from draft metadata", () => {
    const previous = {
      id: "banner-1",
      type: "picture",
      settings: { light: "assets/banner.svg", alt: "Banner" },
    };
    const d = draft([detached()], {
      bannerReference: { blockId: "banner-1", source: "banner" },
      detachments: [record(previous)],
    });
    expect(() => ownershipReviewForRecord(d, "record-1")).toThrow(
      "invalid visual version",
    );
  });

  it.each([
    ["generated", { githubGenerated: { version: 1 } }, {}],
    ["shared", { sharedComponent: "shared-1" }, {}],
    ["profile", { profileIntro: { value: "Original" } }, {}],
    ["banner", {}, { bannerReference: { blockId: "hero-1" } }],
  ])(
    "refuses a same-ID stale %s owner from an open visual form",
    (_kind, ownership, metadata) => {
      const opened = { ...hero(), ...ownership };
      const current = {
        ...structuredClone(opened),
        settings: { ...opened.settings, subtitle: "Owner refreshed" },
      };
      const proposed = {
        ...structuredClone(opened),
        settings: { ...opened.settings, subtitle: "Stale visual proposal" },
      };
      expect(() =>
        ownershipReviewForEdit(draft([current], metadata), opened, proposed),
      ).toThrow("separate reviewed flow");
    },
  );

  it("refuses forbidden ownership introduced while review is open", () => {
    const opened = hero();
    const current = hero("Concurrent builder change");
    const plan = ownershipReviewForEdit(
      draft([current]),
      opened,
      hero("Visual proposal"),
    );
    const generated = {
      ...current,
      githubGenerated: { version: 1 },
      settings: { ...current.settings, subtitle: "Owner refreshed again" },
    };
    expect(() => applyOwnershipReview(draft([generated]), plan)).toThrow(
      "separate reviewed flow",
    );
  });

  it("refuses a Restorable record pointed at an owned target", () => {
    const ownedTarget = { ...detached(), sharedComponent: "shared-target" };
    const d = draft([ownedTarget], { detachments: [record()] });
    expect(() => ownershipReviewForRecord(d, "record-1")).toThrow(
      "separate reviewed flow",
    );
  });

  it("refuses ownership introduced on a detached target while review is open", () => {
    const d = draft([detached()], { detachments: [record()] });
    const plan = ownershipReviewForRecord(d, "record-1");
    const generatedTarget = {
      ...detached(),
      githubGenerated: { version: 1 },
    };
    expect(() =>
      applyOwnershipReview(
        draft([generatedTarget], { detachments: [record()] }),
        plan,
      ),
    ).toThrow("separate reviewed flow");
  });

  it("refuses a record removed or mutated while its review is open", () => {
    const original = record();
    const d = draft([detached()], { detachments: [original] });
    const plan = ownershipReviewForRecord(d, "record-1");

    expect(() =>
      applyOwnershipReview(draft(d.blocks, { detachments: [] }), plan),
    ).toThrow("no longer available");
    expect(() =>
      applyOwnershipReview(
        draft(d.blocks, {
          detachments: [record(hero("Mutated visual copy"))],
        }),
        plan,
      ),
    ).toThrow("changed while Ownership review was open");
  });
});
