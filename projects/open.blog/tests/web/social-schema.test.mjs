// The hosted store for optional social publishing (ADRs 0293 and 0294): additive, private,
// site-scoped by composite keys, shaped for atomic claim and idempotency, and fully undone by the
// rollback. The statements were also run against a real Postgres, twice, then rolled back.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const strip = (sql) => sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").toLowerCase();
const sql = strip(read("../../supabase/social.sql"));
const undo = strip(read("../../supabase/social-rollback.sql"));
const tables = [...sql.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]);

test("the schema is additive, idempotent and uses gen_random_uuid", () => {
  assert.doesNotMatch(sql, /\bdrop\s+(table|column|function|index)\b|\balter\s+table\s+(?!public\.\w+ enable row level security)|\btruncate\b|\bdelete\s+from\b/);
  assert.ok(tables.includes("openblog_social_accounts") && tables.includes("openblog_social_posts") && tables.includes("openblog_social_attempts"));
  assert.equal([...sql.matchAll(/create (unique )?index/g)].length, [...sql.matchAll(/create (unique )?index if not exists/g)].length);
  assert.match(sql, /default gen_random_uuid\(\)/);
  assert.doesNotMatch(sql, /gen_random_policy|uuid_generate|auth\.users|create policy/);
});

test("every table is private: row level security, no public grant, service_role only", () => {
  for (const table of tables) {
    assert.match(sql, new RegExp(`alter table public\.${table} enable row level security`), table);
    assert.match(sql, new RegExp(`revoke all on public\.${table} from public, anon, authenticated`), table);
    assert.match(sql, new RegExp(`grant [a-z, ]+ on public\.${table} to service_role`), table);
  }
  assert.doesNotMatch(sql, /grant [^;]*\bto (anon|authenticated|public)\b/);
  assert.doesNotMatch(sql, /grant [^;]*\bdelete\b/, "the hosted function never deletes");
});

test("every row is bound to a site and relations cannot cross sites", () => {
  for (const table of tables.filter((name) => name !== "openblog_social_schema")) {
    const body = sql.split(`create table if not exists public.${table} (`)[1].split(");")[0];
    assert.match(body, /site_id text not null check \(site_id ~ '\^\[a-za-z0-9\]\[a-za-z0-9\._-\]\{0,79\}\$'\)/, table);
  }
  assert.match(sql, /foreign key \(account_id, site_id\) references public\.openblog_social_accounts \(id, site_id\) on delete restrict/);
  assert.match(sql, /foreign key \(post_id, site_id\) references public\.openblog_social_posts \(id, site_id\) on delete restrict/);
  assert.doesNotMatch(sql, /on delete cascade/, "history is never cascaded away");
});

test("the queue supports atomic claim, idempotency and provider response ids", () => {
  assert.match(sql, /version integer not null default 1/);
  assert.match(sql, /\(status = 'claimed'\) = \(claimed_by is not null and claimed_at is not null and lease_expires_at is not null\)/);
  assert.match(sql, /unique \(site_id, account_id, idempotency_key\)/);
  assert.match(sql, /create index if not exists openblog_social_posts_due on public\.openblog_social_posts \(site_id, scheduled_for\) where status = 'scheduled'/);
  assert.match(sql, /create index if not exists openblog_social_posts_leases[^;]*lease_expires_at\) where status = 'claimed'/);
  assert.match(sql, /\(status = 'published'\) = \(published_at is not null and provider_post_id is not null\)/);
  assert.match(sql, /unique index if not exists openblog_social_posts_provider_post/);
  assert.match(sql, /unique \(post_id, attempt_no\)/);
  assert.match(sql, /outcome in \('published', 'failed', 'unknown'\)/);
});

test("the rollback drops exactly what the schema made and nothing else", () => {
  const dropped = [...undo.matchAll(/drop table if exists public\.(\w+)/g)].map((m) => m[1]);
  for (const table of tables) assert.ok(dropped.includes(table), table);
  for (const name of dropped) assert.match(name, /^openblog_social_/);
  assert.doesNotMatch(undo, /drop extension|openblog_comments|openblog_feedback|openblog_workspaces/);
});
