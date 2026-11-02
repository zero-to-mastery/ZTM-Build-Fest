// The one hosted schema change suggestions for future work need (ADR 0154): a check loosened so a row
// may have a page and no passage, additive and idempotent in supabase/feedback.sql, with a rollback that
// refuses while such a row exists. Nothing here needs the function or any other part of the feature.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const feedbackSql = read("../../supabase/feedback.sql");
const rollback = read("../../supabase/future-suggestions-rollback.sql");
const WORK = "/posts/tides/";

const statementsOf = (sql) => sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").toLowerCase();

test("the one hosted schema change loosens a check additively and idempotently, and its rollback restores it only when safe", () => {
  const added = statementsOf(feedbackSql);
  // A suggestion has a page and no passage: no revision and no target, or all three.
  const loosened = "check ( (revision is null and target is null and (work is null or kind = 'future-suggestion')) or (work is not null and revision is not null and target is not null) )";
  assert.equal(added.split(`constraint openblog_feedback_passage_complete ${loosened},`).length, 2, "a fresh table is created with the loosened check");
  assert.ok(!added.includes("(work is null and revision is null and target is null)"), "the old all-or-none check is gone");
  const tail = added.slice(added.indexOf("alter table public.openblog_feedback drop constraint if exists openblog_feedback_passage_complete"));
  assert.match(tail, /^alter table public\.openblog_feedback drop constraint if exists openblog_feedback_passage_complete; alter table public\.openblog_feedback add constraint openblog_feedback_passage_complete check \( \(revision is null and target is null and \(work is null or kind = 'future-suggestion'\)\) or \(work is not null and revision is not null and target is not null\) \); commit; ?$/, "dropped if it exists, then added: safe to run again");
  // Every row the old check allowed satisfies the new one: all null is a row with no revision or target, and all set is as before.
  const holds = (row, check) => check(row);
  const old = (row) => (row.work === null && row.revision === null && row.target === null) || (row.work !== null && row.revision !== null && row.target !== null);
  const next = (row) => (row.revision === null && row.target === null && (row.work === null || row.kind === "future-suggestion")) || (row.work !== null && row.revision !== null && row.target !== null);
  // Whatever the kind: a comment-like or passage-feedback kind, a third-perspective, or a suggestion.
  for (const kind of ["comment", "passage-feedback", "correction", "third-perspective", "future-suggestion"]) {
    for (const work of [null, WORK]) for (const revision of [null, "p1:x"]) for (const target of [null, {}]) {
      const row = { kind, work, revision, target };
      if (holds(row, old)) assert.ok(next(row), JSON.stringify(row));
    }
  }
  assert.ok(next({ kind: "future-suggestion", work: WORK, revision: null, target: null }) && !old({ work: WORK, revision: null, target: null }), "a suggestion row is what it newly allows");
  assert.ok(!next({ kind: "correction", work: WORK, revision: null, target: null }), "no other kind may have a page without a passage");
  assert.ok(!next({ work: WORK, revision: "p1:x", target: null }) && !next({ work: null, revision: "p1:x", target: {} }), "a half-set passage is still refused");

  const undo = statementsOf(rollback);
  assert.match(undo, /^ ?begin; do \$\$ begin if exists \( select 1 from public\.openblog_feedback where work is not null and \(revision is null or target is null\) \) then raise exception '[^']+'; end if; end \$\$;/, "it refuses while a suggestion row exists");
  assert.match(undo, /alter table public\.openblog_feedback drop constraint if exists openblog_feedback_passage_complete; alter table public\.openblog_feedback add constraint openblog_feedback_passage_complete check \( \(work is null and revision is null and target is null\) or \(work is not null and revision is not null and target is not null\) \); commit; ?$/);
  assert.doesNotMatch(undo, /\bdelete\s+from\b|\btruncate\b|drop table|drop column/, "it never deletes a reader's row itself");
  assert.doesNotMatch(undo, /openblog_comments|openblog_rate_limits/);
  // The rollback's refusal lies in exactly what the loosening admitted.
  assert.ok(old({ work: WORK, revision: "p1:x", target: {} }), "an ordinary passage row never blocks it");
});
