import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// A lab is an HTMLElement subclass, so `this.<name> = …` silently drives a built-in property when
// <name> is one. `this.popover = panelElement` once turned a whole lab into a popover (it became
// position: fixed and left the page flow) while every functional check still passed.
const reserved = [
  "popover", "title", "hidden", "lang", "dir", "inert", "style", "translate", "draggable", "spellcheck",
  "slot", "part", "id", "className", "classList", "children", "dataset", "innerHTML", "outerHTML",
  "textContent", "innerText", "tabIndex", "accessKey", "contentEditable", "autofocus", "nonce",
  "attributes", "parentElement", "firstChild", "lastChild", "shadowRoot", "offsetWidth", "offsetHeight",
];

const dir = new URL("../../web/components/", import.meta.url);
const labs = fs.readdirSync(dir).filter((name) => /^ob-.*-(lab|sandbox)\.js$/.test(name));

test("there are labs to check", () => {
  assert.ok(labs.length >= 6, labs.join(", "));
});

for (const name of labs) {
  test(`${name} never assigns a built-in HTMLElement property on this`, () => {
    const source = fs.readFileSync(new URL(name, dir), "utf8");
    const clashes = [...source.matchAll(/\bthis\.([A-Za-z]+)\s*(?:=(?!=)|\+=)/g)]
      .map((match) => match[1])
      .filter((property) => reserved.includes(property));
    assert.deepEqual(clashes, [], `${name} assigns ${clashes.join(", ")} on this`);
  });
}
