import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { assistantSkillPresentation, selectableAssistantSkillIds } from "../../web/admin/admin.js";

const admin = fs.readFileSync(new URL("../../web/admin/admin.js", import.meta.url), "utf8");

test("assistant skill presentation exposes source, version, scopes, override, and repair state", () => {
  assert.deepEqual(
    assistantSkillPresentation({
      id: "copy-review",
      name: "Local copy review",
      source: "project",
      version: "2",
      scopes: ["selection", "document"],
      valid: true,
      selectable: true,
      overrideState: "active",
      errors: [],
    }),
    {
      title: "Local copy review",
      source: "Project skill",
      details: "Version 2 · Selection, Document · Overrides built-in",
      disabled: false,
      errors: [],
    },
  );
  assert.deepEqual(
    assistantSkillPresentation({
      id: "broken",
      source: "project",
      version: "",
      scopes: [],
      valid: false,
      selectable: false,
      errors: ["Add required front matter field `description`."],
    }),
    {
      title: "broken",
      source: "Project skill",
      details: "Invalid skill",
      disabled: true,
      errors: ["Add required front matter field `description`."],
    },
  );
});

test("assistant skill selection excludes invalid, overridden, and unknown ids", () => {
  const skills = [
    { id: "copy-review", valid: true, selectable: false },
    { id: "copy-review", valid: true, selectable: true, source: "project" },
    { id: "broken", valid: false, selectable: false },
    { id: "technical-review", valid: true, selectable: true },
  ];
  assert.deepEqual(selectableAssistantSkillIds(skills, ["copy-review", "broken", "missing", "technical-review"]), ["copy-review", "technical-review"]);
});

test("Assistant Context view loads and edits Markdown skills through protected APIs", () => {
  assert.match(admin, /api\.call\("GET", "assistant\/skills"\)/);
  assert.match(admin, /const path = editing \? `assistant\/skill\?id=/);
  assert.match(admin, /api\.call\(method, path/);
  assert.match(admin, /aria-label": "Project skill Markdown"/);
  assert.match(admin, /Repair this skill before selecting it/);
  assert.match(admin, /Create project skill/);
});
