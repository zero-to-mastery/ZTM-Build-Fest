import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { SECTION_CATALOG } from "../../web/admin/landing.js";

// The Admin input scan (ADR 0263, #336): no Admin form takes HTML or CSS as free text, nothing writes
// markup into the page through the DOM, and a new field that would is a failing test.

const dir = new URL("../../web/admin/", import.meta.url);
const source = (name) => readFileSync(new URL(name, dir), "utf8");
const files = readdirSync(dir).filter((name) => name.endsWith(".js") || name.endsWith(".html"));
const RISKY = /(?:^|[^a-z])(?:html|css|stylesheet|style|markup|script|javascript|custom[ -]?code|embed[ -]?code|raw[ -]?html)(?:[^a-z]|$)/i;

test("every landing field is a typed control and none is named or labelled for HTML or CSS", () => {
  const allowed = new Set(["text", "textarea", "email", "tel", "url", "number", "select", "list", "group", "post", "richtext"]);
  const seen = [];
  const walk = (fields, where) => {
    for (const field of fields || []) {
      seen.push(field.kind);
      assert.ok(allowed.has(field.kind), `${where}.${field.name}: kind ${field.kind} is not an allowed typed control`);
      // A choice list ("How it looks": primary or secondary) is closed; only free text could take markup.
      if (field.kind !== "select") assert.ok(!RISKY.test(`${field.name} ${field.label}`), `${where}.${field.name}: "${field.label}" invites HTML or CSS`);
      walk(field.fields || field.item?.fields, `${where}.${field.name}`);
    }
  };
  for (const section of SECTION_CATALOG) {
    assert.ok(!RISKY.test(`${section.type} ${section.title}`), `${section.type} is named for HTML or CSS`);
    walk(section.fields, section.type);
  }
  assert.ok(seen.length > 20, "the walk saw the catalog");
});

test("the landing, look, paste and suggestion modules create no text area, no HTML sink and no style or script", () => {
  for (const name of ["landing.js", "look.js", "paste.js", "checks.js", "checks-panel.js", "job-form.js"]) {
    const text = source(name);
    assert.ok(!/(?:h|el|createElement)\(\s*["'`]textarea|<textarea/i.test(text) || name === "landing.js", `${name} creates a text area`);
    for (const sink of [/\.innerHTML\s*=/, /\.outerHTML\s*=/, /insertAdjacentHTML/, /document\.write/, /\.srcdoc\s*=/, /createContextualFragment/, /new DOMParser/, /\beval\(/, /new Function/, /\.style\.cssText/]) {
      assert.ok(!sink.test(text), `${name} uses ${sink}`);
    }
    assert.ok(!/createElement\(["'`](?:script|style|iframe|object|embed)/i.test(text), `${name} creates an active element`);
  }
});

test("only the known, reviewed places write HTML into the document or a frame", () => {
  const sinks = [];
  for (const name of files.filter((n) => n.endsWith(".js"))) {
    source(name).split("\n").forEach((line, index) => {
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
      if (/\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write|createContextualFragment|new DOMParser/.test(line)) sinks.push(`${name}:${index + 1}`);
      if (/\.srcdoc\s*=/.test(line)) sinks.push(`${name}:srcdoc`);
      if (/execCommand\(\s*["']insertHTML["']/.test(line)) sinks.push(`${name}:insertHTML`);
    });
  }
  // The preview frame is sandboxed and takes the server's own page; insertHTML takes only elements the
  // editor's block renderer built from validated Markdown.
  assert.deepEqual(
    [...new Set(sinks)].sort(),
    ["admin.js:insertHTML", "admin.js:srcdoc"],
    "a new HTML sink needs a review and an entry here",
  );
});

test("no Admin control is named for HTML or CSS, except the reviewed code-runner source", () => {
  const reviewed = [/oba-code-interaction-code/];
  const hits = [];
  for (const name of files) {
    source(name).split("\n").forEach((line, index) => {
      if (!/(?:h|el)\(\s*"(?:textarea|input)"|<(?:textarea|input)\b|field\(/.test(line)) return;
      // Look only at the words a person sees or a machine names a control by.
      const named = [...line.matchAll(/(?:id|name|aria-label|placeholder)\s*[:=]\s*[`"']([^`"']*)[`"']/g)].map((m) => m[1]);
      const labelled = [...line.matchAll(/field\(\s*[^,]+,\s*[`"']([^`"']*)[`"']/g)].map((m) => m[1]);
      const text = [...named, ...labelled].join(" ");
      if (RISKY.test(text) && !reviewed.some((rule) => rule.test(line))) hits.push(`${name}:${index + 1}: ${text}`);
    });
  }
  assert.deepEqual(hits, []);
});

test("the look screen offers choices and one color, never a text box for CSS", () => {
  const text = source("admin.js");
  const start = text.indexOf("oba-look-picker");
  assert.ok(start > 0);
  const look = readFileSync(new URL("look.js", dir), "utf8");
  assert.ok(/CHOICES/.test(look));
  assert.equal([...text.matchAll(/id: "oba-look-[a-z-]+"/g)].length >= 1, true);
  assert.ok(!/oba-look-[a-z-]*(?:css|style|font-family|custom)/i.test(text), "a look control is named for CSS");
});
