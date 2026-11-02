// Pure rules for `rust runnable check` fences: no DOM and no network. An author writes the starter
// code, then a `---checks` section of ordinary Rust `#[test]` functions. The page keeps those tests
// out of the editor; when the reader presses "Check my code" the tests are appended to what they
// wrote, the program goes to the Rust Playground in test mode, and the results come back here to be
// turned into the author's own feedback.
//
// Each check's feedback is its doc comment (`/// Add base and bonus together.`). A check with no doc
// comment falls back to its function name. The checks live in the page data, so they are hidden
// from the reader's editor but not secret: this teaches, it does not grade.

export const CHECK_MODULE = "ob_checks";
export const MAX_CHECK_BYTES = 40_000;

function humanise(name) {
  return `The check "${name.replace(/_/g, " ")}" did not pass.`;
}

// The checks an author wrote, in order: [{ name, feedback }].
export function parseChecks(source) {
  const checks = [];
  let docs = [];
  let isTest = false;
  for (const raw of String(source).split("\n")) {
    const line = raw.trim();
    if (line.startsWith("///")) {
      docs.push(line.slice(3).trim());
      continue;
    }
    if (line.startsWith("#[")) {
      if (/^#\[test\]/.test(line)) isTest = true;
      continue;
    }
    const fn = /^(?:pub\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
    if (fn && isTest) {
      const feedback = docs.filter(Boolean).join(" ");
      checks.push({ name: fn[1], feedback: feedback || humanise(fn[1]) });
    }
    if (line) {
      docs = [];
      isTest = false;
    }
  }
  return checks;
}

// The program the Playground compiles: the reader's code with the checks in a child module, so
// they can reach the reader's functions (including private ones) through `use super::*`.
export function buildCheckProgram(code, checks) {
  const body = String(checks)
    .trim()
    .split("\n")
    .map((line) => (line ? `    ${line}` : line))
    .join("\n");
  return `${String(code).replace(/\s+$/, "")}\n\n#[cfg(test)]\nmod ${CHECK_MODULE} {\n    #[allow(unused_imports)]\n    use super::*;\n\n${body}\n}\n`;
}

// Turn a Playground result into { state, passed, total, failures, output }.
// states: "passed", "failed", "compile-error", "unknown".
export function interpretCheck(result, checks) {
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  const seen = new Map();
  for (const match of output.matchAll(/^test (?:ob_checks::)?(\S+) \.\.\. (ok|FAILED|ignored)\s*$/gm)) {
    // Cargo prints the real progress lines first and captured output (which a reader's own code
    // could forge) afterwards, so the first line for a test is the one that counts.
    if (!seen.has(match[1])) seen.set(match[1], match[2]);
  }
  const total = checks.length;
  if (!seen.size) {
    const broken = !result.success || /^error(\[E\d+\])?:/m.test(output);
    return { state: broken ? "compile-error" : "unknown", passed: 0, total, failures: [], output };
  }
  const failures = checks.filter((check) => seen.get(check.name) !== "ok");
  const passed = total - failures.length;
  return { state: failures.length ? "failed" : "passed", passed, total, failures, output };
}

// One sentence for the status line and screen readers.
export function summarise(outcome) {
  if (outcome.state === "passed") {
    return outcome.total === 1 ? "The check passed." : `All ${outcome.total} checks passed.`;
  }
  if (outcome.state === "failed") return `${outcome.passed} of ${outcome.total} checks passed.`;
  if (outcome.state === "compile-error") return "Your code does not compile yet.";
  return "The Rust Playground did not report any check results.";
}
