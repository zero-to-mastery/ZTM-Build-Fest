import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(new URL("../../web/base.css", import.meta.url), "utf8");
const unauthenticatedOrcidIcons = readFileSync(
  new URL("../../web/orcid-unauthenticated-id-icons.png", import.meta.url),
);

test("the bundled unauthenticated ORCID mark keeps its official bytes and 24px crop", () => {
  assert.equal(
    createHash("sha256").update(unauthenticatedOrcidIcons).digest("hex"),
    "f384066e430a04c67d65f379e7ad06d07c4bb582c388d1921199bd9f524a162f",
  );
  assert.match(
    styles,
    /\.ob-orcid-icon\s*{[^}]*width:\s*24px;[^}]*height:\s*24px;[^}]*overflow:\s*hidden;/s,
  );
  assert.match(
    styles,
    /\.ob-orcid-icon img\s*{[^}]*height:\s*48px;[^}]*transform:\s*translate\(-12px, -12px\);/s,
  );
});
