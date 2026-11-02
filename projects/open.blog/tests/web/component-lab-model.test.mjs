import test from "node:test";
import assert from "node:assert/strict";
import {
  defaults, normalize, lightMarkup, lightChildren, hostAttributes, pageRules, notes, shadowBody, shadowStyle,
} from "../../web/components/ob-component-model.js";

test("normalize clamps and rejects unsafe values", () => {
  const c = normalize({ tone: "evil", accent: "red;}", radius: 999, padding: "x", collapsed: 1 });
  assert.equal(c.tone, defaults.tone);
  assert.equal(c.accent, defaults.accent);
  assert.equal(c.radius, 32);
  assert.equal(c.padding, defaults.padding);
  assert.equal(c.collapsed, true);
});

test("default markup writes only what differs from the defaults", () => {
  assert.equal(
    lightMarkup({}),
    '<ob-lab-card tone="info">\n  <h4 slot="title">Reusable card</h4>\n  <p>Anything you put between the tags lands in the default slot.</p>\n</ob-lab-card>',
  );
});

test("attributes, boolean attributes and custom properties appear in the markup", () => {
  const markup = lightMarkup({ tone: "warn", collapsed: true, accent: "#FF0000", radius: 4, footer: true });
  assert.match(markup, /<ob-lab-card tone="warn" collapsed style="--card-accent: #ff0000; --card-radius: 4px">/);
  assert.match(markup, /<small slot="footer">/);
  assert.deepEqual(hostAttributes({ collapsed: true }).attrs, [["tone", "info"], ["collapsed", null]]);
});

test("removing every slotted child produces an empty element", () => {
  assert.deepEqual(lightChildren({ title: false, body: false, footer: false }), []);
  assert.match(lightMarkup({ title: false, body: false }), /<\/ob-lab-card>$/);
});

test("page rules exist only when asked, and notes explain the boundary", () => {
  assert.deepEqual(pageRules({}), []);
  assert.equal(pageRules({ pageCss: true, partCss: true }).length, 3);
  assert.ok(notes({ pageCss: true }).some((line) => /cannot cross the boundary/.test(line)));
  assert.ok(notes({ partCss: true }).some((line) => /part="footer"/.test(line)));
  assert.ok(notes({}).some((line) => /fallback/.test(line)));
});

test("the template the lab displays declares every slot and part the notes mention", () => {
  for (const needle of ['name="title"', 'name="footer"', 'part="footer"', "<slot>"]) {
    assert.ok(shadowBody.includes(needle), needle);
  }
  assert.match(shadowStyle, /:host\(\[collapsed\]\)/);
});
