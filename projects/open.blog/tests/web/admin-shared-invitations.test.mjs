import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  INVITATION_ROLES,
  invitationPayload,
  invitationShareLink,
  invitationTokenFromHash,
  validateInvitationDraft,
} from "../../web/admin/admin.js";

const admin = readFileSync(new URL("../../web/admin/admin.js", import.meta.url), "utf8");
const secret = "a".repeat(64);

test("the invitation payload carries only chosen fields and known roles", () => {
  const payload = invitationPayload("shared-0a1b2c3d4e5f", {
    adminUser: "  grace ",
    contributorId: "grace",
    roles: ["editor", "editor", "root", "reader"],
    lifetimeDays: "3",
    token: "x",
    invitedBy: "participant-1",
  });
  assert.deepEqual(payload, {
    publicationId: "shared-0a1b2c3d4e5f",
    adminUser: "grace",
    contributorId: "grace",
    roles: ["editor", "reader"],
    lifetimeDays: 3,
  });
  assert.equal("lifetimeDays" in invitationPayload("p", { lifetimeDays: "" }), false);
});

test("an invitation draft names the first problem in reading order", () => {
  assert.equal(validateInvitationDraft({}).field, "adminUser");
  assert.equal(validateInvitationDraft({ adminUser: "grace" }).field, "contributorId");
  assert.equal(validateInvitationDraft({ adminUser: "grace", contributorId: "grace" }).field, "roles");
  assert.equal(validateInvitationDraft({ adminUser: "grace", contributorId: "grace", roles: ["reader"] }), null);
  assert.equal(INVITATION_ROLES.filter((role) => role.ownerOnly).length, 1);
});

test("links and tokens are only accepted in the Admin accept route form", () => {
  assert.equal(invitationShareLink("https://blog.example", `/admin/#/shared/accept/shared-0a1b2c3d4e5f.${secret}`), `https://blog.example/admin/#/shared/accept/shared-0a1b2c3d4e5f.${secret}`);
  for (const bad of ["https://evil.example/", "//evil.example", "/other", "", null]) {
    assert.equal(invitationShareLink("https://blog.example", bad), "");
  }
  assert.equal(invitationTokenFromHash(`#/shared/accept/shared-0a1b2c3d4e5f.${secret}`), `shared-0a1b2c3d4e5f.${secret}`);
  for (const bad of ["#/shared/accept/", "#/shared/accept/x", `#/shared/accept/a.${"g".repeat(64)}`, `#/edit/accept/a.${secret}`, `#/shared/new`]) {
    assert.equal(invitationTokenFromHash(bad), "");
  }
});

test("the page never stores the token or sends it before the person chooses", () => {
  const section = admin.slice(admin.indexOf("async showInvitationAccept"), admin.indexOf("// ---- analytics"));
  assert.doesNotMatch(section, /localStorage|sessionStorage|console\./);
  assert.match(section, /accept\.addEventListener\("click"/);
  const panel = admin.slice(admin.indexOf("invitationPanel(publication, index)"), admin.indexOf("async showInvitationAccept"));
  assert.doesNotMatch(panel, /localStorage|sessionStorage|console\./);
  assert.match(panel, /ownerOnly/);
});
