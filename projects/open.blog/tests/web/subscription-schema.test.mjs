// The hosted store for optional update subscriptions (ADR 0225): additive, private, secure tokens,
// digests only, no tie to the feedback table, and a rollback that removes everything it added.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const strip = (sql) => sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").toLowerCase();
const sql = strip(read("../../supabase/subscriptions.sql"));
const undo = strip(read("../../supabase/subscriptions-rollback.sql"));

test("the schema is additive and idempotent", () => {
  assert.doesNotMatch(sql, /\bdrop\s+(table|column|function)\b|\balter\s+table\s+(?!public\.openblog_subscriptions enable)|\btruncate\b|\bdelete\s+from\s+(?!public\.openblog_subscriptions)/);
  assert.match(sql, /create table if not exists public\.openblog_subscriptions/);
  assert.equal([...sql.matchAll(/create (unique )?index/g)].length, [...sql.matchAll(/create (unique )?index if not exists/g)].length);
  assert.equal([...sql.matchAll(/create function/g)].length, 0, "functions are replaced, never failing a second run");
  assert.doesNotMatch(sql, /openblog_feedback|openblog_comments/, "no address can reach a moderation export");
});

test("the table is private and tokens are secure and stored only as digests", () => {
  assert.match(sql, /alter table public\.openblog_subscriptions enable row level security/);
  assert.doesNotMatch(sql, /create policy/);
  assert.match(sql, /revoke all on public\.openblog_subscriptions from public, anon, authenticated/);
  assert.match(sql, /gen_random_bytes\(32\)/);
  assert.doesNotMatch(sql, /\brandom\(\)|now\(\)::text|md5\(/, "no guessable source");
  assert.doesNotMatch(sql, /\b(confirm|unsubscribe)_token text not null|\b(confirm|unsubscribe)_token text check/, "no plaintext token column");
  assert.match(sql, /confirm_digest text check \(confirm_digest ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  const functions = [...sql.matchAll(/create or replace function public\.(\w+)/g)].map((m) => m[1]);
  assert.equal(functions.length, 9);
  for (const name of functions.filter((f) => f !== "openblog_subscription_digest")) {
    assert.match(sql, new RegExp(`grant execute on function public\\.${name}\\(`), name);
  }
  for (const name of functions) assert.match(sql, new RegExp(`revoke all on function public\\.${name}\\(`), name);
  assert.doesNotMatch(sql, /grant execute[^;]*\bto (anon|authenticated|public)\b/);
});

test("consent expires, confirmation is single use, and unsubscribing erases the row", () => {
  assert.match(sql, /interval '48 hours'/);
  assert.match(sql, /set confirm_digest = null/);
  assert.match(sql, /delete from public\.openblog_subscriptions where public\.openblog_subscription_digest\(p_token\) = any \(unsubscribe_digests\)/);
  assert.match(sql, /where not active and requested_at < now\(\) - interval '48 hours'/);
  assert.match(sql, /interval '1 day'/, "at most one update a day");
});

test("a failed confirmation send can be undone, so no address waits for a message that never left", () => {
  assert.match(sql, /create or replace function public\.openblog_cancel_subscription_request\(p_confirm_token text\)/);
  assert.match(sql, /delete from public\.openblog_subscriptions where not active and confirm_digest = public\.openblog_subscription_digest\(p_confirm_token\)/, "only a pending row, found by the digest");
  assert.match(read("../../supabase/subscriptions.sql"), /openblog_subscribe -> send the confirmation message\. If the\s+--\s+send fails, call openblog_cancel_subscription_request/, "the header tells the caller to use it");
});

test("updates wait in a capped queue and are cleared only by a successful send", () => {
  assert.match(sql, /pending_updates jsonb not null default '\[\]'::jsonb check \(jsonb_typeof\(pending_updates\) = 'array' and jsonb_array_length\(pending_updates\) <= 10\)/);
  assert.match(sql, /create or replace function public\.openblog_queue_subscription_update\(/);
  const recipients = sql.match(/create or replace function public\.openblog_subscription_recipients\(.*?end \$\$;/)[0];
  assert.doesNotMatch(recipients, /\bupdate public\.|\binsert\b|\bdelete\b/, "choosing recipients changes nothing");
  assert.match(recipients, /jsonb_array_length\(s\.pending_updates\) > 0/);
  assert.match(recipients, /interval '1 day'/);
  const sent = sql.match(/create or replace function public\.openblog_mark_subscription_sent\(.*?end \$\$;/)[0];
  assert.match(sent, /set last_sent_at = now\(\)/);
  assert.match(sent, /e\.ord > p_count/, "only the updates that were sent are cleared");
  assert.match(sent, /cardinality\(v_digests\) > 8/);
});

test("the rollback drops exactly what was added", () => {
  const added = [...sql.matchAll(/create or replace function public\.(\w+)/g)].map((m) => m[1]);
  for (const name of added) assert.match(undo, new RegExp(`drop function if exists public\\.${name}\\(`), name);
  assert.match(undo, /drop table if exists public\.openblog_subscriptions;/);
  assert.doesNotMatch(undo, /openblog_feedback|openblog_comments|drop extension/);
});
