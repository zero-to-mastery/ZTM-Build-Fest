import { afterEach, describe, expect, it } from "vitest";
import {
  AUDIT_SNAPSHOTS_KEY,
  createAuditSnapshot,
} from "../src/repository-audit/audit-snapshots.js";
import "../src/components/audit-snapshot-history.js";

const snapshot = (account, capturedAt) =>
  createAuditSnapshot({ account, capturedAt, records: [] });

afterEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("audit snapshot history component", () => {
  it("clears a rendered comparison when the account changes", () => {
    localStorage.setItem(
      AUDIT_SNAPSHOTS_KEY,
      JSON.stringify({
        version: 1,
        items: [
          snapshot("alpha", 1),
          snapshot("alpha", 2),
          snapshot("bravo", 3),
          snapshot("bravo", 4),
        ],
      }),
    );
    const element = document.createElement("audit-snapshot-history");
    document.body.append(element);
    const state = {
      username: "alpha",
      results: new Map(),
      typeOverrides: new Map(),
    };
    element.setData(state, false);
    element.querySelector("[data-run]").click();
    expect(element.querySelector("[data-diff]").textContent).toContain(
      "Compared two saved observations",
    );

    element.setData({ ...state, username: "bravo" }, false);
    expect(element.querySelector("[data-diff]").textContent).toBe("");
  });

  it("moves focus to the heading after resetting damaged storage", () => {
    localStorage.setItem(AUDIT_SNAPSHOTS_KEY, "damaged");
    const element = document.createElement("audit-snapshot-history");
    document.body.append(element);
    element.setData(
      { username: "alpha", results: new Map(), typeOverrides: new Map() },
      false,
    );
    element.querySelector("[data-confirm-reset]").checked = true;
    const reset = element.querySelector("[data-reset]");
    reset.focus();
    reset.click();
    expect(document.activeElement).toBe(element.querySelector("h2"));
    expect(element.snapshots.error).toBe("");
  });
});
