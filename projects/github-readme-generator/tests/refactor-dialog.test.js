import { it, expect, vi } from "vitest";
import "../src/components/refactor-dialog.js";
it("holds choices while catalog refresh is pending and ignores obsolete responses", () => {
  vi.stubGlobal(
    "Worker",
    class {
      postMessage() {}
      terminate() {}
    },
  );
  const el = document.createElement("refactor-dialog");
  document.body.append(el);
  try {
    el.configure({ markdown: "# Title", blocks: [], metadata: {} });
    const catalog = [
      { id: "badges", title: "Badges", description: "Row", count: 1 },
    ];
    el.receive({ id: el.requestId, catalog });
    const oldId = el.requestId;
    const choice = el.querySelector("[data-refactor]");
    choice.checked = true;
    choice.dispatchEvent(new Event("change"));
    const mode = el.querySelector("[data-badge-mode]");
    mode.value = "center";
    mode.dispatchEvent(new Event("change"));
    expect(el.querySelector("[data-refactor]").disabled).toBe(true);
    expect(el.querySelector("[data-review]").disabled).toBe(true);
    el.receive({ id: oldId, catalog });
    expect(el.querySelector("[data-refactor]").disabled).toBe(true);
    el.receive({ id: el.requestId, catalog });
    expect(el.querySelector("[data-refactor]").checked).toBe(true);
    expect(el.querySelector("[data-refactor]").disabled).toBe(false);
    expect(el.source).toBe("# Title");
  } finally {
    el.remove();
    vi.unstubAllGlobals();
  }
});
