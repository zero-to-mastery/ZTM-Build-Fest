// Pre-start database snapshot for the Railway test server (start.sh).
//
//   node snapshot.mjs <database> <destination>
//
// Deliberately does not use Kin's DurableStore: opening it runs the current
// code's migrations, so a backup taken through it after a promote would
// already hold the new schema. This copies the database exactly as the
// previous deployment left it, including anything still in its WAL, and
// checks the copy with SQLite's integrity check. Kin isn't running yet, so
// nothing else is writing.
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, linkSync, rmSync } from "node:fs";

const [source, destination] = process.argv.slice(2);
if (!source || !destination || existsSync(destination)) {
  console.error("Usage: node snapshot.mjs <database> <new-destination>");
  process.exit(2);
}
const temporary = `${destination}.${process.pid}.tmp`;
try {
  const db = new DatabaseSync(source);
  try {
    db.prepare("VACUUM INTO ?").run(temporary);
  } finally {
    db.close();
  }
  const copy = new DatabaseSync(temporary, { readOnly: true });
  try {
    const rows = copy.prepare("PRAGMA integrity_check").all();
    if (rows.length !== 1 || Object.values(rows[0])[0] !== "ok")
      throw new Error("The snapshot failed SQLite's integrity check.");
  } finally {
    copy.close();
  }
  chmodSync(temporary, 0o600);
  linkSync(temporary, destination); // never overwrites an existing file
} catch (error) {
  console.error(`Snapshot failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(temporary, { force: true });
}
