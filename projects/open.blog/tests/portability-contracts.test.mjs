import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const registry = JSON.parse(
  readFileSync(new URL("../docs/portability/planned-capability-contracts.json", import.meta.url), "utf8"),
);
const documentation = readFileSync(
  new URL("../docs/portability/planned-capability-contracts.md", import.meta.url),
  "utf8",
);
const issueUrl = (number) =>
  `https://github.com/journey-to-code-org/open.blog/issues/${number}`;

test("each defined capability has one story and a unique portability owner", () => {
  const ids = new Set();
  const ownerIssues = new Set(registry.contracts.map((contract) => contract.portability_owner_issue));
  const stories = new Set();
  const implementations = new Set();

  for (const contract of registry.contracts) {
    assert.match(contract.id, /^[a-z][a-z0-9-]+$/);
    assert.ok(!ids.has(contract.id), `duplicate capability: ${contract.id}`);
    ids.add(contract.id);

    assert.ok(Number.isInteger(contract.portability_owner_issue));
    assert.ok(
      documentation.includes(issueUrl(contract.portability_owner_issue)),
      `${contract.id}: portability-owner issue is not linked from the contract document`,
    );

    if (contract.status === "defined") {
      assert.ok(Number.isInteger(contract.owner_story), `${contract.id}: missing owning story`);
      assert.ok(!stories.has(contract.owner_story), `duplicate story owner: ${contract.owner_story}`);
      stories.add(contract.owner_story);
      assert.ok(
        documentation.includes(issueUrl(contract.owner_story)),
        `${contract.id}: owning story is not linked from the contract document`,
      );
    } else {
      assert.equal(contract.status, "blocked-unscoped", `${contract.id}: unexpected state`);
      assert.equal(contract.owner_story, null, `${contract.id}: unscoped item must not invent a story`);
    }

    for (const issue of contract.implementation_issues) {
      assert.ok(Number.isInteger(issue), `${contract.id}: invalid implementation issue`);
      assert.ok(!ownerIssues.has(issue), `issue has conflicting portability and implementation roles: ${issue}`);
      assert.ok(!implementations.has(issue), `implementation issue has conflicting owners: ${issue}`);
      implementations.add(issue);
    }

    assert.ok(contract.authored_data.length > 0, `${contract.id}: authored semantics are missing`);
    assert.ok(contract.static_fallback.trim(), `${contract.id}: static fallback decision is missing`);
    assert.ok(contract.participation_path.trim(), `${contract.id}: participation path is missing`);
    assert.ok(contract.privacy_exclusions.length > 0, `${contract.id}: privacy exclusions are missing`);
    assert.ok(contract.required_tests.length > 0, `${contract.id}: required tests are missing`);
    assert.ok(contract.scope_boundary.trim(), `${contract.id}: ownership boundary is missing`);
  }
});

test("global completion gates protect canonical content, privacy, and legacy behavior", () => {
  assert.equal(registry.version, 1);
  assert.match(registry.completion_gate, /static fallback/);
  assert.ok(registry.global_invariants.some((invariant) => /backward compatible/.test(invariant)));
  assert.ok(registry.global_invariants.some((invariant) => /never rewrites canonical/.test(invariant)));
  assert.ok(registry.global_invariants.some((invariant) => /Failures are scoped/.test(invariant)));
});

test("diagrams remain blocked until an owning story defines their scope", () => {
  const diagrams = registry.contracts.find((contract) => contract.id === "diagrams");
  assert.equal(diagrams.status, "blocked-unscoped");
  assert.equal(diagrams.owner_story, null);
  assert.deepEqual(diagrams.implementation_issues, []);
  assert.ok(diagrams.required_tests.some((requiredTest) => /create an owning story/.test(requiredTest)));
});

test("an implemented capability names the fallback it ships and keeps its static fallback decision", () => {
  const implemented = registry.contracts.filter((contract) => "implementation_status" in contract);
  // Membership, not equality: each story that ships a capability adds to this list.
  assert.ok(implemented.map((contract) => contract.id).includes("guided-reading-supplements"));
  for (const contract of implemented) {
    assert.equal(contract.implementation_status, "implemented", `${contract.id}: unexpected state`);
    assert.equal(contract.status, "defined", `${contract.id}: it was defined before it was built`);
    assert.match(contract.implemented_fallback, /^[a-z][a-z-]+$/, `${contract.id}: shipped fallback is missing`);
    assert.ok(contract.static_fallback.trim(), `${contract.id}: the static fallback decision stays`);
  }
  const matrix = readFileSync(new URL("../docs/portability/capability-matrix.md", import.meta.url), "utf8");
  assert.ok(!/\| Guided explanations[^|]*\| Planned/.test(matrix), "the matrix still lists reading modes as planned");
});
