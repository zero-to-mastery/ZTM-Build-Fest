import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_ADMIN_PREFERENCES, normalizeAdminPreferences } from "../../web/admin/admin.js";
import { INVITATION_TEXT, buildVoiceInvitation } from "../../web/admin/voice-library.js";
import { invitationVisible } from "../../web/admin/voice.js";
import { withDom } from "./dom-shim.mjs";
import { all, flush, link, text } from "./voice-harness.mjs";

// The one-time invitation (ADR 0277, #452): shown on the Admin home only when there are no samples, no open
// session and no earlier dismissal; Dismiss stores the flag; Start opens the Voice view.

const idle = { session: { open: false }, samples: 0 };

test("the invitation shows only with no samples, no open session and no dismissal", () => {
  assert.equal(invitationVisible({ dismissed: false, status: idle }), true);
  assert.equal(invitationVisible({ dismissed: true, status: idle }), false, "dismissed");
  assert.equal(invitationVisible({ dismissed: false, status: { session: { open: false }, samples: 1 } }), false, "samples exist");
  assert.equal(invitationVisible({ dismissed: false, status: { session: { open: false }, samples: 12 } }), false);
  assert.equal(invitationVisible({ dismissed: false, status: { session: { open: true, expired: false }, samples: 0 } }), false, "a session is active");
  assert.equal(invitationVisible({ dismissed: false, status: { session: { open: true, expired: true }, samples: 0 } }), false, "an expired session still waits to be locked");
  assert.equal(invitationVisible({ dismissed: false, status: { session: { open: true, unreadable: true }, samples: 0 } }), false);
  assert.equal(invitationVisible({ dismissed: false, status: null }), false, "no answer shows nothing");
  assert.equal(invitationVisible({ dismissed: false, status: {} }), false);
  assert.equal(invitationVisible({ dismissed: false, status: { session: { open: false }, samples: "many" } }), false);
});

test("the preference is kept when set, and every other set of preferences keeps its exact shape", () => {
  assert.equal("voiceInvitationDismissed" in DEFAULT_ADMIN_PREFERENCES, false);
  assert.equal("voiceInvitationDismissed" in normalizeAdminPreferences({}), false);
  assert.equal("voiceInvitationDismissed" in normalizeAdminPreferences({ voiceInvitationDismissed: false }), false);
  assert.equal("voiceInvitationDismissed" in normalizeAdminPreferences({ voiceInvitationDismissed: "yes" }), false, "only a real true counts");
  const kept = normalizeAdminPreferences({ preset: "guided", voiceInvitationDismissed: true });
  assert.equal(kept.voiceInvitationDismissed, true);
  assert.equal(kept.preset, "guided");
  assert.equal(normalizeAdminPreferences(kept).voiceInvitationDismissed, true, "it survives a second pass, as a save is made on top of the saved set");
});

test("the card explains the feature, Start is a link to the Voice view, and Dismiss is a button", async () => {
  await withDom(async () => {
    const card = buildVoiceInvitation({ onDismiss: async () => true });
    document.body.append(card.element);
    assert.equal(text(card.element.querySelector("h2")), "Gather your voice");
    assert.equal(text(card.element.querySelector("p")), INVITATION_TEXT);
    assert.match(INVITATION_TEXT, /^A voice sample is a short piece of your own writing/, "it says what a sample is");
    assert.match(INVITATION_TEXT, /the Assistant can use to match how you sound/, "and what it is for");
    assert.match(INVITATION_TEXT, /private by default and never published\.$/);
    assert.equal(INVITATION_TEXT.split(". ").length, 2, "two sentences");
    const start = link(card.element, "voice-invitation-start");
    assert.equal(start.attributes.href, "#/voice");
    assert.match(text(start), /voice session/i);
    const dismiss = all(card.element, "button").find((b) => b.dataset.action === "voice-dismiss");
    assert.equal(dismiss.attributes["aria-label"], "Dismiss this invitation");
    assert.equal(card.element.attributes["aria-labelledby"], card.element.querySelector("h2").attributes.id);
  })();
});

test("Dismiss remembers the choice, removes the card and tells the page", async () => {
  await withDom(async () => {
    const calls = [];
    const card = buildVoiceInvitation({ onDismiss: async () => { calls.push("dismiss"); return true; }, onGone: () => calls.push("gone") });
    document.body.append(card.element);
    const dismiss = all(card.element, "button").find((b) => b.dataset.action === "voice-dismiss");
    await dismiss.click();
    await flush();
    assert.deepEqual(calls, ["dismiss", "gone"]);
    assert.equal(card.element.isConnected, false);
  })();
});

test("a dismissal that could not be saved keeps the card, says so, and can be tried again", async () => {
  await withDom(async () => {
    let fail = true;
    const card = buildVoiceInvitation({ onDismiss: async () => { if (fail) throw new Error("offline"); return true; } });
    document.body.append(card.element);
    const dismiss = all(card.element, "button").find((b) => b.dataset.action === "voice-dismiss");
    await dismiss.click();
    await flush();
    assert.equal(card.element.isConnected, true);
    assert.equal(dismiss.disabled, false);
    assert.match(text(all(card.element, "p").find((p) => p.dataset.voiceInvitationStatus)), /could not be remembered/);
    fail = false;
    await dismiss.click();
    await flush();
    assert.equal(card.element.isConnected, false);
  })();
  await withDom(async () => {
    // Stored settings that cannot be read are never replaced from here.
    const card = buildVoiceInvitation({ onDismiss: async () => false });
    document.body.append(card.element);
    await all(card.element, "button")[0].click();
    await flush();
    assert.equal(card.element.isConnected, true);
  })();
});
