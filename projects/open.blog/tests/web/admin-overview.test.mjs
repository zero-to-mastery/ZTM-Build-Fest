import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const admin = readFileSync(new URL("../../web/admin/admin.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../web/admin/admin.css", import.meta.url), "utf8");

test("overview is the admin home and a searchable workspace command", () => {
  assert.match(admin, /href: "#\/overview"/);
  assert.match(admin, /label: "Overview"/);
  assert.match(admin, /head === "overview" \|\| !head/);
  assert.match(admin, /await this\.showOverview\(params\.get\("focus"\)\)/);
});

test("overview combines content inventory and build status", () => {
  assert.match(admin, /async showOverview\(focus\)/);
  assert.match(admin, /this\.api\.call\("GET", `documents\?kind=\$\{kind\}`\)/);
  assert.match(admin, /this\.api\.call\("GET", "status"\)/);
  for (const label of ["Published", "Drafts", "Scheduled", "Needs attention"]) {
    assert.match(admin, new RegExp(`overviewMetric\\("${label}"`));
  }
  assert.match(admin, /#\/posts\?status=draft/);
  assert.match(admin, /#\/posts\?status=scheduled/);
  assert.match(admin, /#\/overview\?focus=issues/);
  assert.match(admin, /documentProblems/);
  assert.match(admin, /id: "oba-overview-issues"/);
  assert.match(admin, /showList\(KINDS\[head\] \? head : "posts", params\.get\("status"\)\)/);
});

test("overview offers quick creation and recent-content paths", () => {
  assert.match(admin, /Quick create/);
  assert.match(admin, /Recent posts/);
  assert.match(admin, /#\/new\/posts/);
  assert.match(admin, /#\/new\/pages/);
  assert.match(admin, /#\/new\/series/);
  assert.match(styles, /\.oba-overview-grid/);
  assert.match(styles, /\.oba-quick-create/);
  assert.match(styles, /\.oba-recent-list/);
});
