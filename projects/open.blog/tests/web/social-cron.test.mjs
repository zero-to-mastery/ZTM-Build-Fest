// The schedule that wakes the delivery worker (ADR 0317): its secrets live in Vault, its function is
// private to the database owner, and re-running it leaves one job.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const path = (name) => fileURLToPath(new URL(`../../supabase/${name}`, import.meta.url));
const read = (name) => readFileSync(path(name), "utf8");
const strip = (sql) => sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").toLowerCase();

test("the cron schedule keeps its secrets in Vault and its function private", () => {
  const cron = strip(read("social-cron.sql"));
  const cronUndo = strip(read("social-cron-rollback.sql"));
  assert.match(cron, /vault\.decrypted_secrets where name = 'openblog_social_worker_url'/);
  assert.match(cron, /vault\.decrypted_secrets where name = 'openblog_social_worker_key'/);
  assert.match(cron, /revoke all on function public\.openblog_social_worker_ping\(\) from public, anon, authenticated, service_role/);
  assert.match(cron, /v_url !~ '\^https:/, "https only");
  assert.match(cron, /cron\.unschedule\(jobid\) from cron\.job where jobname = 'openblog-social-worker'/, "re-running leaves one job");
  assert.match(cron, /cron\.schedule\('openblog-social-worker', '\* \* \* \* \*'/);
  assert.doesNotMatch(read("social-cron.sql"), /eyJ[A-Za-z0-9_-]{20,}|sb_secret_[A-Za-z0-9]{10,}/, "no key in the file");
  assert.match(cronUndo, /cron\.unschedule/);
  assert.match(cronUndo, /drop function if exists public\.openblog_social_worker_ping/);
});
