import assert from "node:assert/strict";
import test from "node:test";

import { showPrivateContextWarning } from "../../web/admin/admin.js";
import { withDom } from "./dom-shim.mjs";

// A private voice sample that Git tracks could be published or shared by accident (ADR 0266). The
// server names the file in the Context view's warning; the page must show it, plainly, and hide the
// notice again when everything is safe.

const FILE = ".openblog/private/context/voice/2026-10-28-a-mistake-i-made-rough.md";

test(
  "the Context view shows the warning that names a tracked private voice sample",
  withDom(({ document }) => {
    const notice = document.createElement("p");
    notice.hidden = true;
    const sentence = `Your private voice sample ${FILE} is tracked by Git, so it could be published or shared. Remove it from Git with \`git rm --cached\` and make sure /.openblog/private/ is in .gitignore.`;

    const shown = showPrivateContextWarning(notice, { gitRepository: true, tracked: true, trackedVoiceFiles: [FILE], warning: sentence });

    assert.equal(shown, sentence);
    assert.equal(notice.hidden, false);
    assert.ok(notice.textContent.includes(FILE), "the warning names the file");
    assert.doesNotMatch(notice.textContent, /<|undefined|null/);
  }),
);

test(
  "the warning is hidden and emptied when the project is safe, or when there is no Git information",
  withDom(({ document }) => {
    const notice = document.createElement("p");
    notice.textContent = "old warning";
    notice.hidden = false;

    showPrivateContextWarning(notice, { gitRepository: true, tracked: false, trackedVoiceFiles: [], warning: null });
    assert.equal(notice.hidden, true);
    assert.equal(notice.textContent, "");

    notice.textContent = "old warning";
    notice.hidden = false;
    showPrivateContextWarning(notice, undefined);
    assert.equal(notice.hidden, true);
    assert.equal(notice.textContent, "");
  }),
);
