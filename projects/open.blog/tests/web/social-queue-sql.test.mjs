// The hosted delivery queue functions (ADRs 0316 to 0318): additive, private, and the claim is
// atomic. The static checks always run. The behavioural checks run the real SQL against a real
// Postgres when OPENBLOG_TEST_PG_URL names an empty scratch database (a superuser may create roles
// and tables in it; the test removes everything it adds). They are skipped otherwise.
//
//   OPENBLOG_TEST_PG_URL=postgresql://postgres@127.0.0.1:5432/scratch node --test tests/web/social-queue-sql.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const path = (name) => fileURLToPath(new URL(`../../supabase/${name}`, import.meta.url));
const read = (name) => readFileSync(path(name), "utf8");
const strip = (sql) => sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").toLowerCase();
const queue = strip(read("social-queue.sql"));
const undo = strip(read("social-queue-rollback.sql"));
const fullUndo = strip(read("social-rollback.sql"));
const functions = [...queue.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);

test("the queue schema is additive, re-runnable and drops nothing", () => {
  assert.deepEqual(functions.sort(), ["openblog_social_claim_due", "openblog_social_mark_sending", "openblog_social_reap_leases", "openblog_social_settle"]);
  assert.doesNotMatch(queue, /\bdrop\b|\btruncate\b|\bdelete\s+from\b/);
  assert.doesNotMatch(queue, /alter table [^;]*\b(drop|rename|alter column)\b/);
  for (const alter of queue.matchAll(/add column ([^,;]*)/g)) assert.match(alter[1], /^if not exists /);
  assert.match(queue, /create index if not exists openblog_social_posts_reconcile/);
  assert.doesNotMatch(queue, /auth\.users|create policy|gen_random_policy/);
});

test("the claim is atomic: locked rows are skipped, the batch is bounded, the lease and attempt are set together", () => {
  assert.match(queue, /for update of p skip locked/);
  assert.match(queue, /v_limit integer := least\(greatest\(coalesce\(p_limit, 5\), 1\), 25\)/);
  assert.match(queue, /status = 'claimed', claimed_by = p_worker, claimed_at = now\(\), lease_expires_at = now\(\) \+ make_interval/);
  assert.match(queue, /attempt_count = p\.attempt_count \+ 1/);
  assert.match(queue, /insert into public\.openblog_social_attempts \(site_id, post_id, attempt_no, worker\) select c\.site_id, c\.id, c\.attempt_count/);
  assert.match(queue, /p\.status = 'scheduled' and p\.scheduled_for <= now\(\)/, "the status and time are re-checked under the lock");
  assert.match(queue, /a\.paused_until is null or a\.paused_until <= now\(\)/);
  assert.match(queue, /perform public\.openblog_social_reap_leases/);
});

test("every function is scoped to a site, runs as the caller, and only service_role may execute it", () => {
  assert.doesNotMatch(queue, /security definer/);
  assert.equal([...queue.matchAll(/p_site_id !~ '\^\[a-za-z0-9\]/g)].length, 3, "each function that writes a new state checks the site shape");
  for (const name of functions) {
    assert.match(queue, new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon, authenticated`), name);
    assert.match(queue, new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to service_role`), name);
  }
  assert.doesNotMatch(queue, /grant [^;]*\bto (anon|authenticated|public)\b/);
});

test("a lease that ran out after sending is unknown, never sent again; before sending it requeues", () => {
  assert.match(queue, /when v_sent then 'unknown'/);
  assert.match(queue, /'attempts-exhausted'/);
  assert.match(queue, /a\.sending_at is null/);
  assert.match(queue, /p\.lease_expires_at > now\(\)/, "sending needs a live lease");
});

test("a settle is fenced by version and published needs the provider post id", () => {
  assert.match(queue, /where id = p_post_id and site_id = p_site_id and version = p_version and status in \('claimed', 'unknown'\) for update/);
  assert.match(queue, /a published post needs the provider post id/);
  assert.match(queue, /an unknown outcome resolves only to published or failed/);
});

test("the rollbacks remove exactly what the queue added, functions before tables", () => {
  for (const name of functions) {
    assert.match(undo, new RegExp(`drop function if exists public\\.${name}\\(`), name);
    assert.match(fullUndo, new RegExp(`drop function if exists public\\.${name}\\(`), `${name} (full rollback)`);
  }
  assert.ok(fullUndo.indexOf("drop function if exists public.openblog_social_settle") < fullUndo.indexOf("drop table if exists public.openblog_social_posts"));
  for (const column of ["next_attempt_at", "attempt_floor", "reconcile_count", "sending_at", "paused_until"]) assert.match(undo, new RegExp(`drop column if exists ${column}`));
  assert.doesNotMatch(undo, /drop table|drop extension/);
});

// ---- The real SQL, against a real Postgres, when one is supplied. ----

const url = process.env.OPENBLOG_TEST_PG_URL;
const live = url ? test : test.skip;
const psql = (args, input) => execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-At", ...args], { input, encoding: "utf8" }).trim();
const sql = (text) => psql([], text);

live("against a real Postgres: claim, concurrency, leases, settle and the rollbacks", async () => {
  sql(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role bypassrls; end if;
  end $$;`);
  try {
    psql(["-f", path("social.sql")]);
    psql(["-f", path("social-queue.sql")]);
    psql(["-f", path("social-queue.sql")]);
    sql(`insert into openblog_social_accounts (id, site_id, provider, kind, external_id, display_name, connected_by) values
      ('11111111-1111-4111-8111-111111111111','s','linkedin','member','urn:a','A','m'),
      ('22222222-2222-4222-8222-222222222222','s','facebook','page','p1','B','m');
      insert into openblog_social_posts (site_id, account_id, work, canonical_url, body, scheduled_for, idempotency_key, created_by)
      select 's','11111111-1111-4111-8111-111111111111','/p'||i||'/','https://x.example/p'||i||'/','b', now() - interval '1 hour' - i * interval '1 minute', 'key-0000000000000'||lpad(i::text,3,'0'), 'm' from generate_series(1,6) i;
      insert into openblog_social_posts (site_id, account_id, work, canonical_url, body, scheduled_for, idempotency_key, created_by)
      values ('s','22222222-2222-4222-8222-222222222222','/f/','https://x.example/f/','b', now() - interval '1 hour', 'key-0000000000000f01', 'm');`);
    const as = (text) => sql(`set role service_role; ${text}`).split("\n").filter((line) => line && line !== "SET");

    // Skipped providers wait; a wrong site claims nothing; anon may not call.
    assert.deepEqual(as("select count(*) from openblog_social_claim_due('other')"), ["0"]);
    assert.throws(() => sql("set role anon; select openblog_social_claim_due('s')"), /permission denied/);

    // Two sessions claiming at once take disjoint rows.
    const session = (label, hold) =>
      new Promise((resolve, reject) => {
        const child = spawn("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-At"]);
        let out = "";
        child.stdout.on("data", (chunk) => (out += chunk));
        child.on("close", (code) => (code === 0 ? resolve(out.split("\n").filter((l) => l.startsWith(label))) : reject(new Error(`psql ${code}`))));
        child.stdin.end(`set role service_role; begin; select '${label}'||work from openblog_social_claim_due('s','@worker',3,300,5,25,'{facebook}'); select pg_sleep(${hold}); commit;`);
      });
    const [a, b] = await Promise.all([session("A", 2), new Promise((r) => setTimeout(r, 700)).then(() => session("B", 0))]);
    assert.equal(a.length, 3);
    assert.equal(b.length, 3);
    assert.equal(new Set([...a.map((x) => x.slice(1)), ...b.map((x) => x.slice(1))]).size, 6, "no row was claimed twice");
    assert.deepEqual(as("select count(*) from openblog_social_claim_due('s','@worker',5,300,5,3,'{facebook}')"), ["0"]);
    assert.deepEqual(as("select count(*) from openblog_social_attempts"), ["6"]);

    // One sending, one not; both leases run out.
    sql("update openblog_social_posts set lease_expires_at = now() + interval '1 minute' where status = 'claimed'");
    assert.deepEqual(as("select openblog_social_mark_sending('s', id, attempt_count) from openblog_social_posts where work = '/p1/'"), ["t"]);
    assert.deepEqual(as("select openblog_social_mark_sending('s', id, attempt_count) from openblog_social_posts where work = '/p1/'"), ["f"], "only once");
    sql("update openblog_social_posts set lease_expires_at = now() - interval '1 second' where status = 'claimed'");
    assert.deepEqual(as("select openblog_social_mark_sending('s', id, attempt_count) from openblog_social_posts where work = '/p2/'"), ["f"], "an expired lease may not send");
    assert.deepEqual(as("select openblog_social_reap_leases('s')"), ["6"]);
    assert.deepEqual(as("select status from openblog_social_posts where work = '/p1/'"), ["unknown"]);
    assert.deepEqual(as("select status from openblog_social_posts where work = '/p2/'"), ["scheduled"]);

    // Settle is fenced by version and an unknown resolves only to published or failed.
    assert.deepEqual(as("select count(*) from openblog_social_settle('s', (select id from openblog_social_posts where work = '/p1/'), 99, 'published', 'urn:li:share:1')"), ["0"]);
    assert.throws(() => sql("select * from openblog_social_settle('s', (select id from openblog_social_posts where work = '/p1/'), (select version from openblog_social_posts where work = '/p1/'), 'retry')"), /resolves only to published or failed/);
    assert.throws(() => sql("select * from openblog_social_settle('s', (select id from openblog_social_posts where work = '/p1/'), (select version from openblog_social_posts where work = '/p1/'), 'published')"), /provider post id/);
    assert.deepEqual(as("select status || ' ' || provider_post_id from openblog_social_settle('s', (select id from openblog_social_posts where work = '/p1/'), (select version from openblog_social_posts where work = '/p1/'), 'published', 'urn:li:share:1')"), ["published urn:li:share:1"]);
    assert.deepEqual(as("select outcome || ' ' || provider_post_id from openblog_social_attempts where post_id = (select id from openblog_social_posts where work = '/p1/')"), ["published urn:li:share:1"]);
  } finally {
    psql(["-f", path("social-queue-rollback.sql")]);
    psql(["-f", path("social-rollback.sql")]);
  }
  assert.equal(sql("select count(*) from pg_tables where tablename like 'openblog_social%'"), "0");
  assert.equal(sql("select count(*) from pg_proc where proname like 'openblog_social%'"), "0");
});
