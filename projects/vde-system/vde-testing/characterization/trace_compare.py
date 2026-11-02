#!/usr/bin/env python3
"""Compare `vde function-trace ...` output between two repo trees (e.g. base vs refactored).

function-trace prints internal function names, so it cannot be pinned with golden files across a
refactor. This compares the two trees directly under the same fake host, after masking noise:
timestamps, repo roots, per-run HOME, trace-log PIDs, leading indentation and the 'N infrastructure hidden'
summary line (it is only printed when something was hidden, and the action frame now is).
Anything else that differs (including the exit code) is reported.
Usage: trace_compare.py BASE_REPO NEW_REPO"""
import shutil, os, pathlib, re, subprocess, sys, tempfile
import characterize as c

CASES = [  # (args, scenario)  -- every handler, success and failure paths
 (["stop","python"],"images"), (["stop","python"],"running"), (["stop","nosuchvm"],"running"), (["stop"],"running"),
 (["restart","python"],"running"), (["restart","nosuchvm"],"running"), (["restart"],"running"),
 (["remove","python"],"running"), (["remove","python"],"images"), (["remove","nosuchvm"],"images"), (["rm"],"images"),
 (["start","python"],"images"), (["start","python"],"running"), (["start","nosuchvm"],"images"), (["start"],"images"),
 (["start","-f","python"],"running"), (["start","py","go"],"images"), (["start","web"],"cluster"),
 (["enter","python","ls"],"images"), (["enter"],"images"), (["ssh","python"],"images"),
 (["exec","python","ls","-la"],"images"), (["exec"],"images"),
 (["port","python"],"images"), (["port","nosuchvm"],"images"), (["port"],"images"),
 (["help"],"images"), (["-h"],"images"), (["list"],"images"), (["info","web"],"cluster"),
]
TS = re.compile(r"\d{4}-\d\d-\d\dT[0-9:+-]+")

def run(repo, args, scen, tmp):
    work = pathlib.Path(tempfile.mkdtemp(dir=tmp)); home, state = work/"home", work/"state"
    home.mkdir(); state.mkdir()
    env = {"HOME": str(home), "PATH": f"{tmp}/bin:/usr/local/bin:/usr/bin:/bin{c.EXTRA_PATH}", "TERM": "dumb",
           "LC_ALL": "C.UTF-8", "TZ": "UTC", "STUB_STATE": str(state)}
    # Run in a throwaway copy without local state (.cache, .docker-state, ...): results must not depend on run history.
    src = repo
    repo = work/"repo"
    c.copy_clean(src, repo)
    c.scenario(scen, repo, state)
    r = subprocess.run(["zsh", str(repo/"bin"/"vde"), "function-trace", *args], env=env, cwd=str(work),
                       capture_output=True, text=True, timeout=120, stdin=subprocess.DEVNULL)
    def n(t):
        t = t.replace(str(repo), "<ROOT>").replace(str(src), "<ROOT>"); t = TS.sub("<TS>", t); t = re.sub(r"vde-trace-\d+", "vde-trace-<PID>", t)
        t = re.sub(r"(?m)^\s*\d+ infrastructure hidden\s*$", "", t)   # standalone summary line appears only when a frame is hidden
        t = re.sub(r"\d+ infrastructure hidden", "N infrastructure hidden", t)  # count changes by one (the action frame)
        t = t.replace(str(home), "<HOME>")
        t = re.sub(r"\x1b\[[0-9;]*m|\\033\[[0-9;]*m", "", t)
        return [l.strip() for l in t.replace("\r", "\n").split("\n") if l.strip()]
    return r.returncode, n(r.stdout), n(r.stderr)

def main(base, new):
    base, new = pathlib.Path(base).resolve(), pathlib.Path(new).resolve()
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="vdetrace-")); c.make_stubbin(tmp/"bin")
    bad = 0
    for args, scen in CASES:
        a, b = run(base, args, scen, tmp), run(new, args, scen, tmp)
        # mask the tree's own root in messages; compare the rest
        if a == b:
            print(f"same  {' '.join(args):28s} [{scen}] rc={a[0]} stdout={len(a[1])} lines")
        else:
            bad += 1
            print(f"DIFF  {' '.join(args):28s} [{scen}] rc {a[0]}->{b[0]}  stdout {len(a[1])}->{len(b[1])} lines")
            for ln in [x for x in b[1] if x not in a[1]][:3]: print("     + ", ln[:110])
            for ln in [x for x in a[1] if x not in b[1]][:3]: print("     - ", ln[:110])
    print(f"{len(CASES)-bad}/{len(CASES)} trace cases equivalent")
    return 1 if bad else 0

if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:3]))
