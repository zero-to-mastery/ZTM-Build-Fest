# sccache (optional): when installed, cargo compiles through it so dependency
# crates are served from its cache instead of being recompiled. Builds fall
# back to plain rustc when sccache is missing, so it is never required. A
# caller-provided RUSTC_WRAPPER (set, or explicitly empty to disable) wins.
export RUSTC_WRAPPER := env_var_or_default('RUSTC_WRAPPER', `command -v sccache 2>/dev/null || true`)

# ponytail: Homebrew Rust has no rustup llvm-tools; coverage uses llvm@22 to match rustc 1.98's LLVM 22. Bump the formula when `rustc -vV` reports a new LLVM major.
export LLVM_COV := env_var_or_default('LLVM_COV', '/opt/homebrew/opt/llvm@22/bin/llvm-cov')
export LLVM_PROFDATA := env_var_or_default('LLVM_PROFDATA', '/opt/homebrew/opt/llvm@22/bin/llvm-profdata')

# Review changes and pass just test before committing.
commit MSG:
    git add --all
    git diff --cached --check
    git commit -m {{quote(MSG)}}

test:
    cargo test --workspace

check:
    cargo check --workspace

clippy:
    cargo clippy --workspace --all-targets -- -D warnings

fmt:
    cargo fmt -- --check

fmt-fix:
    cargo fmt

# Run all linters (check + clippy + fmt check + test-attr guard + doc rules)
lint:
    cargo check --workspace
    just clippy
    cargo fmt -- --check
    just lint-testattr
    just lint-rules
    just lint-filelen

# Check that code names in AGENTS.md, docs/dev and the Record exist in orb, and that docs/dev/architecture.md names no bus
lint-rules:
    python3 scripts/lint-rules.py
    python3 scripts/lint-rules.py --self-test

# Fail when a Rust file's production part (lines before its first top-level #[cfg(test)]) passes LIMIT lines. Test-only files (the list in scripts/lint-rules.py) have no production part.
lint-filelen LIMIT="2000":
   #!/usr/bin/env python3
   import importlib, os, sys
   LIMIT = int("{{LIMIT}}")
   sys.path.insert(0, "scripts")
   TEST_ONLY = importlib.import_module("lint-rules").TEST_ONLY
   bad = []
   for root in ("crates", "src"):
       for dirpath, dirnames, filenames in os.walk(root):
           dirnames[:] = [d for d in dirnames if d != "target"]
           for fn in filenames:
               if not fn.endswith(".rs") or fn in TEST_ONLY:
                   continue
               path = os.path.join(dirpath, fn)
               with open(path, encoding="utf-8") as f:
                   lines = f.readlines()
               prod = next((i for i, l in enumerate(lines) if l.startswith("#[cfg(test)]")), len(lines))
               if prod > LIMIT:
                   bad.append((path, prod))
   for path, prod in sorted(bad):
       print(f"ERROR: {path}: {prod} production lines (cap {LIMIT}); split it by concern", file=sys.stderr)
   sys.exit(1 if bad else 0)

# Fail on bare #[test]/#[tokio::test] lacking an rstest attr (escapes the rstest timeout)
lint-testattr:
   #!/usr/bin/env python3
   import os
   import re
   import sys

   ALLOWLIST = set()
   SKIP_DIRS = {"target", ".git", ".plans"}

   def is_test_attr(s):
       if re.fullmatch(r"#\[test\]", s):
           return True
       return bool(re.fullmatch(r"#\[tokio::test(?:\([^()]*(?:\([^()]*\)[^()]*)?\))?\]", s))

   offenders = []
   for dirpath, dirnames, filenames in os.walk(os.getcwd()):
       dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
       for fn in filenames:
           if not fn.endswith(".rs"):
               continue
           fpath = os.path.join(dirpath, fn)
           rel = os.path.normpath(os.path.relpath(fpath, os.getcwd()))
           if rel in ALLOWLIST:
               continue
           with open(fpath, encoding="utf-8") as f:
               lines = f.readlines()
           i, n = 0, len(lines)
           while i < n:
               s = lines[i].strip()
               if s.startswith("#["):
                   # Walk the contiguous attribute region (multi-line ok).
                   depth = 0
                   has_rstest = False
                   has_bare = False
                   bare_line = None
                   j = i
                   while j < n:
                       sj = lines[j].strip()
                       depth += sj.count("[") + sj.count("(")
                       depth -= sj.count("]") + sj.count(")")
                       if "rstest" in sj:
                           has_rstest = True
                       if depth == 0 and is_test_attr(sj):
                           has_bare = True
                           bare_line = j + 1
                       if depth <= 0:
                           nxt = j + 1
                           if nxt < n and lines[nxt].strip().startswith("#["):
                               j = nxt
                               continue
                           break
                       j += 1
                   else:
                       j = n - 1
                   if has_bare and not has_rstest:
                       offenders.append((rel, bare_line))
                   i = j + 1
               else:
                   i += 1

   for rel, ln in offenders:
       print(f"ERROR: {rel}:{ln}: bare test attribute lacks an #[rstest::rstest] companion", file=sys.stderr)
   if offenders:
       print(
           f"\n{len(offenders)} test(s) would run WITHOUT the rstest timeout.\n"
           "Stack #[rstest::rstest] above the attribute (or extend the allowlist\n"
           "in the lint-testattr recipe with a stated reason).",
           file=sys.stderr,
       )
       sys.exit(1)

coverage:
    cargo llvm-cov --workspace --lcov --output-path coverage.lcov

coverage-report:
    cargo llvm-cov report --html

debt: coverage
    debtmap analyze . --lcov coverage.lcov
