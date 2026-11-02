#!/usr/bin/env python3
"""Run the repo's own function-trace BDD feature and the zsh unit suite against a repo copy,
using the same fake docker as characterize.py (plus docker inspect State.Running support).
Usage: bdd_check.py /path/to/vde-system
Exit 0 only if every scenario passes and every unit file exits 0."""
import os, pathlib, re, shutil, subprocess, sys, tempfile
import characterize as c

def main(repo):
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="vdebdd-"))
    try:
        root, home, state, binp = tmp / "repo", tmp / "home", tmp / "state", tmp / "bin"
        shutil.copytree(repo, root, symlinks=True, ignore=shutil.ignore_patterns(".git", "logs", ".locks", "__pycache__"))
        home.mkdir(); state.mkdir(); c.make_stubbin(binp)
        stub = c.DOCKER_STUB.replace("  info|version)", '''  inspect) case " $* " in *State.Running*) n="${@: -1}"
          if grep -qxF "$n" "$S/running"; then echo true; exit 0
          elif grep -qxF "$n" "$S/containers"; then echo false; exit 0; else exit 1; fi;; esac
        exit 0;;
  info|version)''')
        (binp / "docker").write_text(stub)
        (state / "images").write_text("vde-base:latest\nvde-python:latest\nvde-rust:latest\nvde-go:latest\n")
        env = dict(os.environ, HOME=str(home), STUB_STATE=str(state), TERM="dumb", LC_ALL="C.UTF-8",
                   PATH=f"{binp}:{os.environ['PATH']}")
        ok = True
        r = subprocess.run([sys.executable, "-m", "behave", "tests/features/governance/function-trace.feature",
                            "--no-color", "-f", "progress"], cwd=root, env=env, capture_output=True, text=True, timeout=600)
        m = re.search(r"(\d+) scenarios passed, (\d+) failed", r.stdout)
        print("BDD function-trace:", m.group(0) if m else r.stdout[-400:])
        ok &= bool(m) and m.group(2) == "0"
        for t in sorted((root / "tests" / "unit").glob("*.test.zsh")):
            p = subprocess.run(["zsh", str(t)], cwd=root, env=env, capture_output=True, text=True, timeout=300)
            print(f"unit {t.name:34s} rc={p.returncode}")
            ok &= p.returncode == 0
        print("ALL GREEN" if ok else "FAILURES PRESENT")
        return 0 if ok else 1
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
