#!/usr/bin/env python3
"""Doc rules for orb.

- Name check: every code name the docs in DOCS put in backticks (outside
  fenced blocks) must exist in orb's code. A listed doc that doesn't exist
  is skipped (the public repo has no .agents/RECORD.md).
- Architecture deny-list: docs/dev/architecture.md must not describe a bus.
- Dropped results: production Rust code must not `let _ =` a kill or removal,
  nor drop an error report with a `|_report|` closure.
- zmx list sites: each file's production `zmx … .list(` count must match the
  reviewed ZMX_LIST_SITES, so a new site fails until someone checks that a
  failed list there keeps panes rather than closing or killing them.
- Unlimited programs: a `.output()` call anywhere in Rust code (tests too)
  outside the timed runners in OUTPUT_ALLOWED fails, since it runs a program
  with no time limit.
- Unlimited waits: a `.status()` after a call chain in production code fails,
  since it waits on a program with no time limit; so does a `.wait()` anywhere
  in Rust code (tests too) outside the reviewed WAIT_ALLOWED files.

`--self-test` plants a bad name, a bad phrase, a dropped kill, a dropped
report, an unreviewed zmx list site, an unlimited `.output()`, a bare
`.status()` and a bare `.wait()`, and exits 0 only if all are reported and
neither a dropped kill in a test-only file nor a `.wait()` in a reviewed file
is.

Test-only files (`tests.rs`, `test_support.rs`) have no production part.
"""

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = [
    "AGENTS.md",
    "docs/dev/architecture.md",
    "docs/dev/rust-style.md",
    "docs/dev/testing.md",
    "docs/dev/keybindings.md",
    ".agents/RECORD.md",
    "README.md",
    "CHANGELOG.md",
    "docs/keys.md",
]
ARCHITECTURE = "docs/dev/architecture.md"
CODE_DIRS = ["crates", "src"]

# Names the docs may mention that orb's code doesn't have.
ALLOWLIST = {
    "RSTEST_TIMEOUT": "rstest's environment variable, in docs/dev/testing.md",
    "clippy::missing_assert_message": "clippy lint name, in docs/dev/testing.md",
    "replace_all": "example inside the Record's own format template",
}

DENY_PHRASES = ["actor host", "pub/sub", "message bus"]
DENY_WORD = re.compile(r"\bbus\b", re.IGNORECASE)

# Production code that may drop a kill or removal result.
LET_DROP_ALLOWLIST = {
    ("crates/orb-term/src/pane.rs", ".kill("): "dropping a pane's attach client kills it; a client already gone is fine",
    ("crates/orb-domain/src/common/child.rs", ".kill("): "a timed-out helper is killed; its error is the timeout already returned",
}
# The whole statement up to its `;`, so a `let _ =` whose call is on a later line still matches.
LET_DROP = re.compile(
    r"let _ =[^;]*?(\.kill\(|remove_worktree|delete_branch|remove_dir_all|remove_file|delete_)",
    re.S,
)
DROPPED_REPORT = re.compile(r"\|_report\|")
TEST_MODULE = re.compile(r"^#\[cfg\(test\)\]", re.M)

# Production `zmx list` call sites per file, each reviewed to mean "keep" on error.
ZMX_LIST = re.compile(r"zmx\s*\.list\(")
ZMX_LIST_SITES = {
    "crates/orb-tui/src/run/panes.rs": 4,
    # classify_exits (shown sessions only): error -> None -> the pane respawns, never ends
    #   (exited_client_with_unlistable_zmx_keeps_its_pane, classify_exit's zmx_unknown case)
    # plan_resumes: error -> None -> nothing typed (resume_plan_types_nothing_where_zmx_couldnt_list)
    # reattach_live sweep: error -> empty -> nothing killed (stale_sessions_kills_nothing_when_zmx_lists_nothing)
    # reattach_live running: error -> empty -> panes come back as fresh shells, no kill
    #   (start_attaches_a_session_whose_panes_all_died)
    "crates/orb-domain/src/feat/sessions/sessions_actor.rs": 1,
    # poll probe (ticker): error -> that dir's panes left as they were (poll_leaves_a_pane_agent_as_it_was_when_zmx_cant_list)
    "crates/orb-domain/src/feat/sessions/sessions_actor/settle.rs": 1,
    # kill_settled: error -> empty -> nothing killed (kill_settled_kills_nothing_when_zmx_cant_list)
}

# Files that may call `.output()`: each one runs it under its own time limit.
OUTPUT = re.compile(r"\.output\(\)")
OUTPUT_ALLOWED = {
    "crates/orb-domain/src/feat/harness/claude/supervisor.rs": "the async timed runner: tokio timeout over output() with kill_on_drop",
}
# A `.status()` that ends a call chain: `Command::new(..)....status()`.
STATUS = re.compile(r"\)\s*\.status\(\)")
# Files that may call a bare `.wait()`, each reviewed.
WAIT = re.compile(r"\.wait\(\)")
WAIT_ALLOWED = {
    "crates/orb-domain/src/common/child.rs": "the timed runner: it waits only on a child it just killed",
    "crates/orb-term/src/pane.rs": "a pane's reaper waits on the pane's own program, which lives as long as the pane",
}

SPAN = re.compile(r"`([^`\n]+)`")
IDENT = re.compile(r"^[A-Za-z_]\w*(::\w+)*$")
SUBCOMMAND = re.compile(r"^(claude|zmx|git|pi) ([a-z][a-z-]+)")


def in_code(*rg_args):
    result = subprocess.run(
        ["rg", "-q", *rg_args, "--", *CODE_DIRS, "install.sh"], cwd=ROOT, capture_output=True
    )
    if result.returncode > 1:
        sys.exit(f"lint-rules: rg failed: {result.stderr.decode().strip()}")
    return result.returncode == 0


def span_ok(span):
    if IDENT.match(span) and (re.search(r"[A-Z_]", span) or "::" in span):
        return in_code("-w", "-F", span.split("::")[-1])
    sub = SUBCOMMAND.match(span)
    if sub:
        return in_code("-F", f'"{sub.group(2)}"')
    return True


def check_names(label, text):
    """Report backticked code names outside fenced blocks that orb's code doesn't have."""
    reports = []
    fenced = False
    for number, line in enumerate(text.splitlines(), start=1):
        if line.startswith("```"):
            fenced = not fenced
            continue
        if fenced:
            continue
        for span in SPAN.findall(line):
            if span in ALLOWLIST:
                continue
            if not span_ok(span):
                reports.append(f"{label}:{number}: unknown name `{span}`")
    return reports


def check_bus(label, text):
    """Report bus wording anywhere in the architecture doc."""
    reports = []
    for number, line in enumerate(text.splitlines(), start=1):
        found = [p for p in DENY_PHRASES if p in line.lower()]
        found += [m.group(0) for m in DENY_WORD.finditer(line)]
        reports += [f"{label}:{number}: must not say `{word}`" for word in found]
    return reports


TEST_ONLY = ("tests.rs", "test_support.rs")


def production(label, text):
    """The text before a file's first `#[cfg(test)]` line; nothing in a test-only file."""
    if label.rsplit("/", 1)[-1] in TEST_ONLY:
        return ""
    test = TEST_MODULE.search(text)
    return text[: test.start()] if test else text


def check_drops(label, text):
    """Report dropped kill/removal results and dropped error reports in production code."""
    code = production(label, text)
    reports = []
    for found in LET_DROP.finditer(code):
        if (label, found.group(1)) in LET_DROP_ALLOWLIST:
            continue
        number = code.count("\n", 0, found.start()) + 1
        reports.append(f"{label}:{number}: dropped kill/remove result")
    for found in DROPPED_REPORT.finditer(code):
        number = code.count("\n", 0, found.start()) + 1
        reports.append(f"{label}:{number}: dropped error report")
    return reports


def check_zmx_lists(label, text):
    """Report a file whose production `zmx … .list(` count differs from the reviewed list."""
    found = len(ZMX_LIST.findall(production(label, text)))
    want = ZMX_LIST_SITES.get(label, 0)
    if found == want:
        return []
    return [
        f"{label}: {found} zmx list call sites, reviewed {want}; "
        "check that a failed list there keeps, then update ZMX_LIST_SITES"
    ]


def check_outputs(label, text):
    """Report `.output()` calls, which run a program with no time limit."""
    if label in OUTPUT_ALLOWED:
        return []
    return [
        f"{label}:{text.count(chr(10), 0, found.start()) + 1}: "
        ".output() runs a program with no time limit; use run_within"
        for found in OUTPUT.finditer(text)
    ]


def check_statuses(label, text):
    """Report `.status()` calls in production code, which wait on a program with no time limit."""
    code = production(label, text)
    return [
        f"{label}:{code.count(chr(10), 0, found.start()) + 1}: "
        ".status() waits on a program with no time limit; use run_within"
        for found in STATUS.finditer(code)
    ]


def check_waits(label, text):
    """Report `.wait()` calls outside the reviewed files, which wait on a program with no time limit."""
    if label in WAIT_ALLOWED:
        return []
    return [
        f"{label}:{text.count(chr(10), 0, found.start()) + 1}: "
        ".wait() waits on a program with no time limit; use wait_within"
        for found in WAIT.finditer(text)
    ]


def rust_files():
    for code_dir in CODE_DIRS:
        for path in sorted((ROOT / code_dir).rglob("*.rs")):
            if "target" not in path.relative_to(ROOT).parts:
                yield path


def self_test():
    names = check_names("self-test", "Uses `NoSuchTypeForSelfTest` here.\n")
    deny = check_bus("self-test", "Events go on the message bus.\n")
    kill = check_drops("self-test", "fn f() {\n    let _ = zmx\n        .kill(&s);\n}\n")
    blind = check_drops("self-test/tests.rs", "fn f() {\n    let _ = zmx\n        .kill(&s);\n}\n")
    report = check_drops("self-test", "fn f() {\n    x.map_err(|_report| X);\n}\n")
    zmx = check_zmx_lists("self-test", "fn f() {\n    self.zmx\n        .list(dir);\n}\n")
    output = check_outputs("self-test", "fn f() {\n    c.output();\n}\n")
    status = check_statuses("self-test", "fn f() {\n    Command::new(p)\n        .status();\n}\n")
    wait = check_waits("self-test", "fn f() {\n    child.wait();\n}\n")
    reviewed = check_waits("crates/orb-term/src/pane.rs", "fn f() {\n    child.wait();\n}\n")
    for line in names + deny + kill + report + zmx + output + status + wait:
        print(line)
    if blind:
        print("self-test: a test-only file was checked as production")
        return 1
    if reviewed:
        print("self-test: a .wait() in a reviewed file was reported")
        return 1
    if not all([names, deny, kill, report, zmx, output, status, wait]):
        print("self-test: a check did not fail on its planted text")
        return 1
    print("self-test: every check reported its planted text")
    return 0


def main():
    if "--self-test" in sys.argv[1:]:
        return self_test()
    reports = []
    for doc in DOCS:
        path = ROOT / doc
        if path.exists():
            reports += check_names(doc, path.read_text())
    reports += check_bus(ARCHITECTURE, (ROOT / ARCHITECTURE).read_text())
    for path in rust_files():
        rel = str(path.relative_to(ROOT))
        text = path.read_text()
        reports += check_drops(rel, text)
        reports += check_zmx_lists(rel, text)
        reports += check_outputs(rel, text)
        reports += check_statuses(rel, text)
        reports += check_waits(rel, text)
    for report in reports:
        print(report)
    if reports:
        return 1
    print("lint-rules: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
