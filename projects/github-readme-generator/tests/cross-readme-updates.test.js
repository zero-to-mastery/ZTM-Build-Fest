import { describe, it, expect } from "vitest";
import { newDraft } from "../src/state/drafts.js";
import {
  emptyShared,
  saveShared,
  planShared,
  selectSharedPlan,
  checkSharedPlan,
} from "../src/workspace/shared-components.js";
import "../src/components/shared-components.js";

function workspace() {
  const old = saveShared(emptyShared(), {
    name: "Testing Stack",
    markdown: "## Testing\nOld tools",
  });
  const drafts = Array.from({ length: 8 }, (_, index) => {
    const draft = newDraft(`Repository ${index + 1}`);
    const entry = planShared([draft], old.items[0], [draft.id], "insert")
      .entries[0];
    return { ...draft, blocks: entry.blocks, markdown: entry.markdown };
  });
  return {
    drafts,
    active: drafts[0].id,
    sharedComponents: saveShared(old, {
      ...old.items[0],
      markdown: "## Testing\nNew tools",
    }),
  };
}
describe("cross-README update selection", () => {
  it("narrows eight reviewed changes without changing snapshots, order or sources", () => {
    const data = workspace(),
      before = structuredClone(data);
    const preview = planShared(
      data.drafts,
      data.sharedComponents.items[0],
      data.drafts.map((d) => d.id),
      "update",
    );
    expect(preview.entries).toHaveLength(8);
    const plan = selectSharedPlan(preview, [
      data.drafts[5].id,
      data.drafts[1].id,
      data.drafts[5].id,
    ]);
    expect(plan.entries).toEqual([preview.entries[1], preview.entries[5]]);
    expect(data).toEqual(before);
    expect(preview.entries).toHaveLength(8);
    expect(() => selectSharedPlan(preview, ["unknown"])).toThrow();
    expect(() =>
      checkSharedPlan(
        selectSharedPlan(preview, []),
        data.drafts,
        data.sharedComponents,
      ),
    ).toThrow(/No document/);
  });
  it("checks stale state only for recipients but always checks the definition", () => {
    const data = workspace();
    const preview = planShared(
      data.drafts,
      data.sharedComponents.items[0],
      data.drafts.map((d) => d.id),
      "update",
    );
    const plan = selectSharedPlan(preview, [data.drafts[0].id]);
    data.drafts[1].markdown = "Unselected local changes";
    expect(() =>
      checkSharedPlan(plan, data.drafts, data.sharedComponents),
    ).not.toThrow();
    data.drafts[0].markdown = "Selected local changes";
    expect(() =>
      checkSharedPlan(plan, data.drafts, data.sharedComponents),
    ).toThrow(/document changed/);
  });
  it("shows affected count, defaults to no recipients and clears approval when recipients change", () => {
    const data = workspace(),
      el = document.createElement("shared-components");
    el.configure(data, true);
    el.querySelector("[data-component]").value =
      data.sharedComponents.items[0].id;
    el.select();
    el.preview("update", true);
    expect(el.querySelector("h1").textContent).toBe("Cross-README updates");
    expect(el.querySelector("[data-impact]").textContent).toContain(
      "Affected: 8 READMEs · Selected: 0",
    );
    expect(el.querySelectorAll("[data-entry]")).toHaveLength(8);
    expect(el.canApply()).toBe(false);
    const checkbox = el.querySelector("[data-receive]");
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));
    el.querySelector("[data-approve]").checked = true;
    expect(el.canApply()).toBe(true);
    el.querySelector("[data-select-all]").click();
    expect(el.plan.entries).toHaveLength(8);
    expect(el.canApply()).toBe(false);
    el.querySelector("[data-select-none]").click();
    expect(el.plan.entries).toEqual([]);
    expect(data.drafts.every((d) => d.markdown.includes("Old tools"))).toBe(
      true,
    );
  });
});
