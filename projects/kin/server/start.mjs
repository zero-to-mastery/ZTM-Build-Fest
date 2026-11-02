// Starts the Kin service inside Node's permission model (server/permissions.mjs).
// This launcher is the only part that may start a process; the service itself
// cannot. It creates the data directory first (the sandbox can only write
// inside it), hands the service the canonical database path (the model
// compares paths as written, so a symlinked path would be denied), forwards
// stop requests, and exits with the service's code (server/launcher.mjs).
//
//   node server/start.mjs                      the service, sandboxed
//   node server/start.mjs --install-service    run it as a service (ADR 0025 §10)
//   node server/start.mjs --help               every command
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runLauncher } from "./launcher.mjs";

const version = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")).version;

const code = await runLauncher(process.argv.slice(2), {
  version,
  serviceProcess: ({ flags, env }) => ({ command: process.execPath, args: [...flags, join(import.meta.dirname, "server.mjs")], env }),
  // A service manager starts the same node with this file.
  program: { kind: "node", command: process.execPath, args: [join(import.meta.dirname, "start.mjs")] },
});
process.exit(code);
