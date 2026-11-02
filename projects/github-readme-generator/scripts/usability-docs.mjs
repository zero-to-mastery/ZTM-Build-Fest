// Reads the Usability scenario table in docs/usability-scripts.md and the
// Friction tracker in docs/usability-findings.md (ADR 0006). The Scripted runs
// take their step budgets from the scripts doc, so a budget changes only with
// the doc, and the tracker is checked so that automated or implementer
// findings are never filed as Participant session results.

export const AUDIENCES = { N: "Novice", E: "Experienced" };
export const FOUND_BY = [
  "Scripted run",
  "Heuristic walkthrough",
  "Participant session",
];
export const STATUSES = ["Open", "Fixed"];
export const SEVERITIES = {
  1: "cannot complete",
  2: "completes only with help, a workaround or more than 2 wrong turns",
  3: "hesitation",
  4: "cosmetic",
};
// The tracker's sections and the one kind of run each may hold.
export const SECTIONS = {
  "Scripted run baseline (automated)": "Scripted run",
  "Heuristic walkthrough (implementer, not user evidence)":
    "Heuristic walkthrough",
  "Participant sessions": "Participant session",
};
export const NONE_RECORDED = "None recorded";

const cells = (line) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
const isDivider = (line) => /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(line);
const key = (heading) =>
  heading
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim();

// Every Markdown table in `markdown`, with the `## ` section it sits under.
export function markdownTables(markdown) {
  const tables = [];
  let section = "",
    current = null;
  for (const line of String(markdown).split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) section = heading[1];
    if (!isTableRow(line)) {
      current = null;
      continue;
    }
    if (!current) {
      current = { section, header: cells(line).map(key), rows: [] };
      tables.push(current);
    } else if (!isDivider(line)) {
      const values = cells(line);
      current.rows.push(
        Object.fromEntries(current.header.map((h, i) => [h, values[i] ?? ""])),
      );
    }
  }
  return tables;
}

// The scenario table: ID | Audience | Start state | Success criterion | Step
// budget. Throws with every problem found, so a broken doc fails loudly.
export function parseScenarios(markdown) {
  const table = markdownTables(markdown).find(
    (t) => t.header.includes("id") && t.header.includes("step budget"),
  );
  if (!table) throw new Error("No scenario table with a Step budget column.");
  const problems = [],
    scenarios = [];
  for (const row of table.rows) {
    const id = row.id,
      budget = Number(row["step budget"]);
    if (!/^[NE]\d+$/.test(id)) problems.push(`Scenario ID "${id}" is invalid.`);
    else if (scenarios.some((s) => s.id === id))
      problems.push(`Scenario ${id} is listed twice.`);
    if (row.audience !== AUDIENCES[id[0]])
      problems.push(`Scenario ${id} must be ${AUDIENCES[id[0]] || "known"}.`);
    if (!Number.isInteger(budget) || budget < 1)
      problems.push(`Scenario ${id} needs a whole-number step budget.`);
    for (const field of ["start state", "success criterion"])
      if (!row[field]) problems.push(`Scenario ${id} has no ${field}.`);
    scenarios.push({
      id,
      audience: row.audience,
      start: row["start state"],
      success: row["success criterion"],
      budget,
    });
  }
  if (!scenarios.length) problems.push("The scenario table is empty.");
  if (problems.length) throw new Error(problems.join("\n"));
  return scenarios;
}

export function scenarioBudget(scenarios, id) {
  const scenario = scenarios.find((s) => s.id === id);
  if (!scenario) throw new Error(`Scenario ${id} is not documented.`);
  return scenario.budget;
}

// The Friction tracker rows, each with the tracker section it was found in.
// Every table with a "Found by" column counts, wherever it sits, so a row
// under any other heading is reported by validateFindings instead of skipped.
export function parseFindings(markdown) {
  const text = String(markdown);
  const sections = [...text.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1]);
  const missing = Object.keys(SECTIONS).filter((s) => !sections.includes(s));
  if (missing.length)
    throw new Error(`Missing tracker sections: ${missing.join(", ")}.`);
  const findings = markdownTables(text)
    .filter((t) => t.header.includes("found by"))
    .flatMap((t) =>
      t.rows.map((row) => ({
        id: row.id,
        scenario: row.scenario,
        step: row.step,
        audience: row.audience,
        foundBy: row["found by"],
        severity: Number(row.severity),
        status: row.status,
        fix: row["fix pr test"] ?? "",
        section: t.section,
      })),
    );
  const participants = text
    .split(/^##\s+/m)
    .find((part) => part.startsWith("Participant sessions"));
  return {
    findings,
    participantSessionsRecorded: !participants.includes(NONE_RECORDED),
  };
}

// Test references in a Fix PR/test cell, written as `tests/...` paths.
export const testReferences = (fix) =>
  [...String(fix).matchAll(/`(tests\/[^`\s]+\.(?:test|spec)\.js)`/g)].map(
    (m) => m[1],
  );

// Returns a list of problems; empty means the tracker is consistent.
export function validateFindings(
  { findings, participantSessionsRecorded },
  scenarios,
) {
  const problems = [],
    ids = new Set();
  for (const f of findings) {
    const name = f.id || "(no ID)";
    if (!/^F\d+$/.test(f.id)) problems.push(`Finding ID "${name}" is invalid.`);
    else if (ids.has(f.id)) problems.push(`Finding ${f.id} is listed twice.`);
    ids.add(f.id);
    const scenario = scenarios.find((s) => s.id === f.scenario);
    if (!scenario)
      problems.push(`${name} names unknown scenario "${f.scenario}".`);
    else if (f.audience !== scenario.audience)
      problems.push(`${name} audience must match ${scenario.id}.`);
    if (!f.step) problems.push(`${name} names no step.`);
    if (!FOUND_BY.includes(f.foundBy))
      problems.push(`${name} has unknown "found by" "${f.foundBy}".`);
    else if (SECTIONS[f.section] !== f.foundBy)
      problems.push(
        `${name} (${f.foundBy}) is filed under "${f.section || "no section"}".`,
      );
    if (!(f.severity in SEVERITIES))
      problems.push(`${name} needs a severity from 1 to 4.`);
    if (!STATUSES.includes(f.status))
      problems.push(`${name} has unknown status "${f.status}".`);
    if (f.status === "Fixed" && !testReferences(f.fix).length)
      problems.push(`${name} is Fixed but links no regression test.`);
    // Severity 1-2 items found without participants are fixed in the same
    // release; participant items are fixed once the maintainer records them.
    if (
      f.severity <= 2 &&
      f.foundBy !== "Participant session" &&
      f.status !== "Fixed"
    )
      problems.push(`${name} is severity ${f.severity} and still open.`);
  }
  if (
    !participantSessionsRecorded &&
    findings.some((f) => f.foundBy === "Participant session")
  )
    problems.push(
      `Participant sessions say "${NONE_RECORDED}" but list findings.`,
    );
  return problems;
}
