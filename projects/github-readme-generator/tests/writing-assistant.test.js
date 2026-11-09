import { describe, it, expect, vi } from "vitest";
import {
  actions,
  scopes,
  writingMessages,
  replaceScope,
} from "../src/writing/model.js";
import { connection, generateWriting } from "../src/writing/client.js";
import { createBlock } from "../src/markdown/serialize.js";
import "../src/components/writing-assistant.js";

const config = {
  endpoint: "https://provider.example/v1/chat/completions",
  model: "test-model",
  key: "secret-key",
};
const input = {
  action: "improve",
  original: "Selected content",
  notes: "Keep meaning",
};
const response = (content = "Better content", extra = {}) =>
  new Response(
    JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content }, ...extra }],
    }),
  );

describe("writing scope and instructions", () => {
  it("defines every requested action with a fact-preserving prompt", () => {
    expect(Object.keys(actions)).toHaveLength(10);
    for (const key of Object.keys(actions)) {
      const messages = writingMessages(key, "Text", "Notes");
      expect(messages[0].content).toContain("Never invent");
      expect(JSON.parse(messages[1].content)).toEqual({
        original: "Text",
        notes: "Notes",
      });
    }
    expect(() => writingMessages("__proto__", "Text")).toThrow();
  });
  it("uses exact Unicode/CRLF selection offsets and ignores headings in code", () => {
    const source =
      "# Title\r\n\r\nHi 🌍\r\n```md\r\n## fake\r\n```\r\n## Next\r\nBye";
    const start = source.indexOf("Hi"),
      end = start + "Hi 🌍".length;
    const ranges = scopes(source, start, end);
    expect(ranges[0]).toMatchObject({ id: "selection", start, end });
    expect(
      ranges.filter((r) => r.id.startsWith("section:")).map((r) => r.label),
    ).toEqual(["Section: Title", "Section: Next"]);
    expect(replaceScope(source, ranges[0], "Hello")).toBe(
      source.slice(0, start) + "Hello" + source.slice(end),
    );
  });
  it("supports drafting at an empty cursor with notes and bounds input/output", () => {
    expect(scopes("", 0, 0)).toEqual([
      { id: "cursor", label: "New section at cursor", start: 0, end: 0 },
    ]);
    expect(() => writingMessages("draft", "", "A Rust parser")).not.toThrow();
    expect(() => writingMessages("improve", "", "notes")).toThrow();
    expect(() => writingMessages("draft", "", "")).toThrow();
    expect(() => writingMessages("improve", "x".repeat(32001))).toThrow();
    expect(() => replaceScope("a", { start: 0, end: 2 }, "x")).toThrow();
    expect(() => replaceScope("a", { start: 0, end: 1 }, " ")).toThrow();
    expect(() =>
      replaceScope("a", { start: 0, end: 1 }, "x".repeat(64001)),
    ).toThrow();
  });
});

describe("optional provider boundary", () => {
  it("allows HTTPS and explicit loopback, rejecting unsafe endpoint/key formats", () => {
    for (const endpoint of [
      "http://localhost:1234/v1/chat/completions",
      "http://127.0.0.1:8000/chat/completions",
      "http://[::1]:1234/chat/completions",
    ])
      expect(connection({ ...config, endpoint, key: "" }).endpoint).toBe(
        endpoint,
      );
    for (const endpoint of [
      "http://provider.example/chat/completions",
      "https://user:pass@provider.example/chat/completions",
      "javascript:alert(1)",
      "https://provider.example/chat/completions?key=secret",
      "https://provider.example/chat/completions#x",
      "https://provider.example/other",
    ])
      expect(() => connection({ ...config, endpoint })).toThrow();
    expect(() => connection({ ...config, key: "key\nInjected" })).toThrow();
    expect(() => connection({ ...config, model: "" })).toThrow();
  });
  it("sends only action instructions, selected content and notes without cookies or redirects", async () => {
    const fetcher = vi.fn(async () => response());
    expect(await generateWriting(config, input, { fetcher })).toBe(
      "Better content",
    );
    const [url, request] = fetcher.mock.calls[0];
    expect(url).toBe(config.endpoint);
    expect(request).toMatchObject({
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      cache: "no-store",
    });
    expect(request.headers.Authorization).toBe("Bearer secret-key");
    const body = JSON.parse(request.body);
    expect(body).toMatchObject({
      model: "test-model",
      stream: false,
      store: false,
    });
    expect(JSON.parse(body.messages[1].content)).toEqual({
      original: input.original,
      notes: input.notes,
    });
    expect(request.body).not.toContain(config.key);
  });
  it("rejects incomplete, refused, tool, empty and oversized output", async () => {
    for (const result of [
      response("partial", { finish_reason: "length" }),
      response("", {}),
      response("x".repeat(64001)),
      response("text", { message: { refusal: "no" } }),
      response("text", { message: { content: "hi", tool_calls: [{}] } }),
    ])
      await expect(
        generateWriting(config, input, { fetcher: async () => result }),
      ).rejects.toThrow();
  });
  it("does not leak provider error bodies or retry billed requests", async () => {
    for (const status of [401, 403, 404, 429, 500]) {
      const fetcher = vi.fn(
        async () => new Response("secret-key private payload", { status }),
      );
      await expect(
        generateWriting(config, input, { fetcher }),
      ).rejects.not.toThrow(/secret-key|private payload/);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it("rejects malformed and bounded oversized response streams", async () => {
    await expect(
      generateWriting(config, input, {
        fetcher: async () => new Response("not json"),
      }),
    ).rejects.toThrow("invalid JSON");
    await expect(
      generateWriting(config, input, {
        fetcher: async () => new Response("x".repeat(512001)),
      }),
    ).rejects.toThrow("too large");
    await expect(
      generateWriting(config, input, {
        fetcher: async () =>
          new Response("x", { headers: { "content-length": "512001" } }),
      }),
    ).rejects.toThrow("too large");
  });
  it("times out, cancels and explains network/CORS errors", async () => {
    const waiting = (_url, { signal }) =>
      new Promise((_, reject) => {
        if (signal.aborted) reject(new DOMException("Aborted", "AbortError"));
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    await expect(
      generateWriting(config, input, { fetcher: waiting, timeout: 5 }),
    ).rejects.toThrow("timed out");
    const controller = new AbortController();
    controller.abort();
    await expect(
      generateWriting(config, input, {
        fetcher: waiting,
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
    await expect(
      generateWriting(config, input, {
        fetcher: async () => {
          throw new TypeError("Failed to fetch");
        },
      }),
    ).rejects.toThrow("CORS");
  });
});

describe("Original / Proposed / Diff / Apply", () => {
  const setup = () => {
    const el = document.createElement("writing-assistant");
    const markdown = "Before\nSelected\nAfter";
    el.configure(
      {
        id: "draft",
        name: "Draft",
        markdown,
        blocks: [createBlock("custom", { markdown })],
        metadata: {},
      },
      7,
      15,
    );
    return el;
  };
  it("defaults to the existing section at EOF, leaving insertion explicit", () => {
    const el = document.createElement("writing-assistant");
    const markdown = "# Current section";
    el.configure(
      {
        id: "draft",
        name: "Draft",
        markdown,
        blocks: [createBlock("custom", { markdown })],
        metadata: {},
      },
      markdown.length,
      markdown.length,
    );
    expect(el.range().id).toBe("section:0");
    expect(el.querySelector("[data-original]").value).toBe(markdown);
    expect(el.querySelector("[data-action-choice]").value).toBe("improve");
  });
  it("does not approve proposals until the exact diff has been reviewed", () => {
    const el = setup();
    expect(el.querySelector("[data-original]").value).toBe("Selected");
    el.querySelector("[data-proposed]").value = "Improved";
    expect(el.canApply()).toBe(false);
    el.review();
    expect(el.canApply()).toBe(false);
    expect(el.plan).toBe("Before\nImproved\nAfter");
    el.querySelector("[data-approve]").checked = true;
    expect(el.canApply()).toBe(true);
    el.querySelector("[data-proposed]").value = "Changed";
    expect(el.canApply()).toBe(false);
  });
  it("displays malicious proposals as inert source and rejects unchanged proposals", () => {
    const el = setup();
    el.querySelector("[data-proposed]").value = "Selected";
    el.review();
    expect(el.plan).toBeNull();
    el.querySelector("[data-proposed]").value =
      '<img src=x onerror="window.injected=true"><script>evil()</script>';
    el.review();
    expect(el.querySelector("script,img")).toBeNull();
    expect(el.querySelector("[data-after]").value).toContain("<script>");
    expect(window.injected).toBeUndefined();
  });
});
