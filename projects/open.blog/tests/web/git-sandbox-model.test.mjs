import test from "node:test";
import assert from "node:assert/strict";
import { initialState, run, layout, headCommit } from "../../web/components/ob-git-model.js";

const play = (...lines) => lines.reduce((state, line) => run(state, line).state, initialState());

test("commit advances the checked-out branch only", () => {
  const state = play("git switch -c feature", "git commit -m one");
  assert.notEqual(state.branches.feature, state.branches.main);
  assert.equal(headCommit(state), state.branches.feature);
  assert.equal(state.commits[state.branches.feature].parents[0], state.branches.main);
});

test("merging an ancestor-descendant pair fast-forwards unless --no-ff", () => {
  const base = play("git switch -c feature", "git commit", "git switch main");
  const ff = run(base, "git merge feature");
  assert.equal(ff.state.branches.main, base.branches.feature);
  assert.match(ff.output, /Fast-forward/);
  const noff = run(base, "git merge --no-ff feature");
  assert.equal(noff.state.commits[noff.state.branches.main].parents.length, 2);
});

test("different files on diverged branches merge cleanly", () => {
  const state = play("git switch -c a", "git commit -f a.txt", "git switch main", "git commit -f b.txt", "git merge a");
  const tip = state.commits[state.branches.main];
  assert.equal(tip.parents.length, 2);
  assert.deepEqual(Object.keys(tip.tree).sort(), ["README.md", "a.txt", "b.txt"]);
  assert.equal(state.merging, null);
});

test("same file on both sides conflicts, resolves, and commits", () => {
  let result = run(play("git switch -c a", "git commit", "git switch main", "git commit"), "git merge a");
  assert.equal(result.error, true);
  assert.deepEqual(result.state.merging.conflicts, ["README.md"]);
  assert.equal(run(result.state, "git commit").error, true);
  assert.equal(run(result.state, "git switch a").error, true);
  result = run(result.state, "resolve --theirs README.md");
  result = run(result.state, "git commit");
  assert.equal(result.error, false);
  assert.equal(result.state.merging, null);
  assert.equal(result.state.commits[headCommit(result.state)].parents.length, 2);
});

test("merge --abort restores a clean state", () => {
  const conflicted = run(play("git switch -c a", "git commit", "git switch main", "git commit"), "git merge a").state;
  assert.equal(run(conflicted, "git merge --abort").state.merging, null);
});

test("rejects bad branch names, duplicates, and unknown commands", () => {
  for (const line of ["git branch ..x", "git branch -x", "git branch main", "git push", "ls", "git switch nope"]) {
    assert.equal(run(initialState(), line).error, true, line);
  }
});

test("detached HEAD commits do not move a branch", () => {
  const first = play("git commit");
  const root = Object.values(first.commits).find((c) => !c.parents.length).id;
  const detached = run(first, `git switch ${root}`).state;
  const after = run(detached, "git commit").state;
  assert.equal(after.branches.main, first.branches.main);
  assert.equal(after.head, headCommit(after));
});

test("layout puts branches on separate lanes and merges one generation later", () => {
  const state = play("git switch -c a", "git commit -f a", "git switch main", "git commit -f b", "git merge a");
  const { nodes, rows } = layout(state);
  assert.equal(rows, 2);
  const merge = nodes.find((n) => n.id === state.branches.main);
  assert.equal(merge.x, Math.max(...nodes.map((n) => n.x)));
});

test("quoted messages and log output", () => {
  const state = play('git commit -m "two words"');
  assert.match(run(state, "git log").output, /\(HEAD -> main\) two words/);
});
