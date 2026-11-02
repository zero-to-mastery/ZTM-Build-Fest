import { describe, it, expect, vi } from "vitest";
import {
  variants,
  generateAlternatives,
  duplicateAlternatives,
} from "../src/writing/alternatives.js";
import { writingMessages } from "../src/writing/model.js";
import "../src/components/writing-assistant.js";
describe("rewrite alternatives", () => {
  const input = {
    action: "summary",
    original: "Technical notes",
    notes: "Facts only",
    context: [{ id: "metadata", content: "CLI" }],
  };
  it("uses distinct style instructions while preserving the same facts and grounding", () => {
    const requests = Object.keys(variants).map((id) =>
      writingMessages(
        input.action,
        input.original,
        input.notes,
        input.context,
        id,
      ),
    );
    expect(new Set(requests.map((r) => r[0].content)).size).toBe(3);
    expect(new Set(requests.map((r) => r[1].content)).size).toBe(1);
    for (const request of requests) {
      expect(request[0].content).toContain("omit it");
      expect(request[0].content).toContain("README summary");
    }
    expect(() =>
      writingMessages("summary", "notes", "", [], "unknown"),
    ).toThrow();
  });
  it("runs three sequential requests and retains independent output", async () => {
    let active = 0,
      max = 0;
    const calls = [];
    const result = await generateAlternatives({}, input, {
      generate: async (_config, request) => {
        active++;
        max = Math.max(max, active);
        calls.push(request);
        await Promise.resolve();
        active--;
        return request.variant + " output";
      },
    });
    expect(max).toBe(1);
    expect(calls.map((c) => c.variant)).toEqual([
      "concise",
      "technical",
      "friendly",
    ]);
    expect(result.map((r) => r.status)).toEqual(["ready", "ready", "ready"]);
    expect(
      calls.every(
        (c) => c.original === input.original && c.context === input.context,
      ),
    ).toBe(true);
  });
  it("stops on failure without retry and preserves partial results", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce("First")
      .mockRejectedValueOnce(Error("Rate limited"));
    const result = await generateAlternatives({}, input, { generate });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.map((r) => r.status)).toEqual([
      "ready",
      "failed",
      "not generated",
    ]);
    expect(result[0].text).toBe("First");
  });
  it("cancellation stops subsequent requests and suppresses late output", async () => {
    const controller = new AbortController();
    const generate = vi.fn(async () => {
      controller.abort();
      return "late";
    });
    const result = await generateAlternatives({}, input, {
      generate,
      signal: controller.signal,
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.every((r) => r.status === "not generated" && !r.text)).toBe(
      true,
    );
  });
  it("detects identical provider alternatives without pretending they are distinct", () => {
    expect(
      duplicateAlternatives([
        { status: "ready", text: "same" },
        { status: "ready", text: "same\n" },
      ]),
    ).toBe(true);
    expect(
      duplicateAlternatives([
        { status: "ready", text: "one" },
        { status: "ready", text: "two" },
      ]),
    ).toBe(false);
  });
  it("choosing a version only stages Proposed and requires new diff approval", () => {
    const el = document.createElement("writing-assistant");
    el.configure(
      {
        id: "d",
        name: "Draft",
        markdown: "Original",
        blocks: [],
        metadata: {},
      },
      0,
      8,
    );
    el.querySelector("[data-proposed]").value = "Previous";
    el.review();
    el.querySelector("[data-approve]").checked = true;
    expect(el.canApply()).toBe(true);
    const compare = el.querySelector("writing-comparison");
    compare.show([
      {
        id: "friendly",
        label: "Friendly",
        status: "ready",
        text: "<script>evil()</script>Friendly",
      },
    ]);
    compare.querySelector("button").click();
    expect(el.querySelector("[data-proposed]").value).toContain("Friendly");
    expect(el.canApply()).toBe(false);
    expect(el.draft.markdown).toBe("Original");
    expect(el.querySelector("script")).toBeNull();
    el.review();
    el.querySelector("[data-approve]").checked = true;
    expect(el.canApply()).toBe(true);
  });
  it("previews all three messages and invalidates context/mode changes", () => {
    const el = document.createElement("writing-assistant");
    el.configure(
      { id: "d", name: "Draft", markdown: "Notes", blocks: [], metadata: {} },
      0,
      5,
    );
    el.querySelector("[data-mode]").value = "compare";
    el.resetInput();
    const preview = JSON.parse(el.querySelector("[data-request]").value);
    expect(preview.map((p) => p.alternative)).toEqual([
      "Concise",
      "Technical",
      "Friendly",
    ]);
    el.alternatives = [{ id: "concise", text: "Old", status: "ready" }];
    el.querySelector("[data-consent]").checked = true;
    el.resetInput();
    expect(el.alternatives).toEqual([]);
    expect(el.querySelector("[data-consent]").checked).toBe(false);
  });
});
