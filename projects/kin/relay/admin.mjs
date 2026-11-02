#!/usr/bin/env node
// The relay operator's commands, on the registry file (relay/README.md):
//
//   node relay/admin.mjs suspend <name>     stop routing a name after an abuse report
//   node relay/admin.mjs unsuspend <name>
//   node relay/admin.mjs status <name>      the registry's row and 30 days' usage
//   node relay/admin.mjs errors             error codes and counts
//
// A running relay applies a suspension within a minute (it closes the
// tunnel with GOAWAY 5). Suspension never moves a name to another key.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Registry } from "./registry.mjs";

export function runAdmin(args, env = process.env, out = console.log) {
  const [command, name] = args;
  const zone = env.KIN_RELAY_ZONE;
  if (!zone) throw new Error("KIN_RELAY_ZONE is required.");
  const registry = new Registry({ zone, path: join(env.KIN_RELAY_DATA_DIR || "/var/lib/kin-relay", "registry.sqlite") });
  try {
    switch (command) {
      case "suspend":
      case "unsuspend":
        if (!registry.suspend(String(name ?? "").toLowerCase(), command === "suspend")) throw new Error(`No free name ${name} in the registry.`);
        out(`${name} is ${command === "suspend" ? "suspended" : "routed again"}.`);
        return 0;
      case "status": {
        const row = registry.sql.nameRow.get(String(name ?? "").toLowerCase());
        if (!row) { out(registry.sql.retired.get(name) ? `${name} is retired.` : `${name} is not claimed.`); return 0; }
        out(JSON.stringify({
          name: row.name, keyHash: Buffer.from(row.key_hash).toString("base64url"), claimedDay: new Date(row.claimed_day * 86_400_000).toISOString().slice(0, 10),
          lastSeenDay: new Date(row.last_seen_day * 86_400_000).toISOString().slice(0, 10), caaAccountUri: row.caa_account_uri, suspended: Boolean(row.suspended),
          certified: row.certified_day !== null, bytes30Days: registry.usage(row.name),
        }, null, 2));
        return 0;
      }
      case "errors":
        out(JSON.stringify(registry.errors(), null, 2));
        return 0;
      default:
        out("Usage: node relay/admin.mjs suspend|unsuspend|status <name> | errors");
        return 2;
    }
  } finally { registry.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try { process.exitCode = runAdmin(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
