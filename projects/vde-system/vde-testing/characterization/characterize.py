#!/usr/bin/env python3
"""
Characterization harness for the `vde` CLI (bin/vde).

Purpose: pin down WHAT vde does today, at its outer boundary, so that internals can be
refactored (e.g. routed through lib/vde-parser) without changing behavior.

For every case it records, in a throwaway copy of the repo with a recording fake `docker`:
  * exit code
  * normalized stdout / stderr
  * every `docker` invocation (argv)
  * files added / removed / modified in the repo copy and in $HOME (paths only)
Two delegate modes:
  * "stub"  - every bin/* script that bin/vde hands work to is replaced by a recorder, so the
              case pins the ROUTER contract (which script, with which argv, after alias /
              cluster / default / all expansion).
  * "real"  - delegates run for real against the fake docker (used for start/stop/restart/
              remove/create/rebuild, where the interesting behavior is the docker calls).

Usage:
  characterize.py record  --repo /path/to/vde-system [--only SUBSTR]
  characterize.py check   --repo /path/to/vde-system [--only SUBSTR]
  characterize.py stable  --repo /path/to/vde-system        # record twice, prove determinism
  characterize.py list
"""
import argparse, concurrent.futures as cf, difflib, hashlib, json, os, pathlib, re, shutil
import subprocess, sys, tempfile

# Directory holding the host's zsh when it is outside the standard dirs, so the fixed test PATH can still find it.
_zsh = shutil.which("zsh")
EXTRA_PATH = (":" + os.path.dirname(_zsh)) if _zsh and os.path.dirname(_zsh) not in ("/usr/bin", "/bin", "/usr/local/bin") else ""


HERE = pathlib.Path(__file__).resolve().parent
GOLDEN = HERE / "golden"
TIMEOUT = 120

# Every script bin/vde hands work to (frozen from bin/vde at ff77e79; do NOT derive at run
# time, or a refactored bin/vde would silently stop being stubbed).
DELEGATES = """nuke-vde vde-init vde-path-of-the-foundling vde-rebuild vde-exec ssh-vm ssh-setup
ssh-sync ssh-agent-setup list-vms add-vm-type uninstall-vm-type validate-schemas.zsh
vde-prune.zsh vde-rebuild-cache vde-sync-version vde-sync-context vde-gospel-audit.zsh
vde-check-tetrad.zsh vde-heal-docs.zsh vde-info vde-ps vde-inspect vde-dns-check.zsh vde-logs
vde-images vde-networks vde-stats vde-health vde-cluster vde-vision vde-matrix-audit.zsh
vde-matrix-rebuild.zsh""".split()

# --------------------------------------------------------------------------------------
# Fake host tools (docker records + keeps a tiny state; uptime/df pinned for determinism)
# --------------------------------------------------------------------------------------
DOCKER_STUB = r'''#!/bin/bash
# Recording fake docker. State lives in $STUB_STATE/{containers,running,images}.
S="${STUB_STATE:?}"; touch "$S/containers" "$S/running" "$S/images"
{ printf 'docker'; for a in "$@"; do printf ' %q' "$a"; done; printf '\n'; } >> "$S/docker.log"
add()  { grep -qxF "$2" "$S/$1" || echo "$2" >> "$S/$1"; }
del()  { grep -vxF "$2" "$S/$1" > "$S/$1.tmp"; mv "$S/$1.tmp" "$S/$1"; }
case "$1" in
  ps)   all=0; for a in "$@"; do [ "$a" = "-a" ] && all=1; done
        if [ $all = 1 ]; then cat "$S/containers"; else cat "$S/running"; fi; exit 0;;
  stop) del running "$2"; echo "$2"; exit 0;;
  start) add running "$2"; echo "$2"; exit 0;;
  rm)   n="${@: -1}"; del running "$n"; del containers "$n"; echo "$n"; exit 0;;
  image) if [ "$2" = "inspect" ]; then grep -qxF "$3" "$S/images" && { echo "[]"; exit 0; }; exit 1; fi
         exit 0;;
  build) prev=""; for a in "$@"; do [ "$prev" = "-t" ] && add images "$a"; prev="$a"; done; exit 0;;
  network) [ "$2" = "inspect" ] && { echo "[]"; exit 0; }; exit 0;;
  compose) f=""; prev=""; up=0; bld=0
        for a in "$@"; do [ "$prev" = "-f" ] && f="$a"; [ "$a" = "up" ] && up=1; [ "$a" = "build" ] && bld=1; prev="$a"; done
        n="vde-$(basename "$(dirname "$f")")"
        [ $up = 1 ]  && { add containers "$n"; add running "$n"; }
        [ $bld = 1 ] && add images "$n:latest"
        exit 0;;
  info|version) echo "stub-docker"; exit 0;;
  *) exit 0;;
esac
'''
UPTIME_STUB = '#!/bin/sh\necho " 00:00:00 up 1 day,  1 user,  load average: 0.10, 0.10, 0.10"\n'
DF_STUB = ('#!/bin/sh\necho "Filesystem Size Used Avail Use% Mounted on"\n'
           'echo "/dev/stub 100G 10G 90G 10% /"\n')
DELEGATE_STUB = ('#!/usr/bin/env zsh\nprint -r -- "[delegate:${0:t}] argc=$# ${(q-)@}"\n'
                 'exit ${STUB_DELEGATE_RC:-0}\n')

# --------------------------------------------------------------------------------------
# Scenarios: initial fake-host state
# --------------------------------------------------------------------------------------
def _lines(p, items): pathlib.Path(p).write_text("".join(i + "\n" for i in items))
BASE_IMAGES = ["vde-base:latest", "vde-python:latest", "vde-go:latest",
               "vde-postgres:latest", "vde-jupyterlab:latest"]

def scenario(name, root, state):
    _lines(state / "containers", []); _lines(state / "running", []); _lines(state / "images", [])
    if name == "empty":
        return
    _lines(state / "images", BASE_IMAGES)
    if name == "images":
        return
    if name == "running":
        _lines(state / "containers", ["vde-python", "vde-postgres"])
        _lines(state / "running", ["vde-python"])
        return
    if name == "cluster":
        d = root / ".docker-state" / "clusters"; d.mkdir(parents=True, exist_ok=True)
        (d / "web.json").write_text('{"name": "web", "vms": ["python", "postgres"]}\n')
        return
    raise SystemExit(f"unknown scenario {name}")

# --------------------------------------------------------------------------------------
# Case matrix
# --------------------------------------------------------------------------------------
def build_cases():
    cases = []
    def add(cid, args, scen="images", mode="stub", env=None):
        cases.append(dict(id=cid, args=args, scenario=scen, mode=mode, env=env or {}))

    # ---- Layer B: inline handlers, real delegates, fake docker ----------------------
    for scen in ("empty", "images", "running"):
        add(f"start.python.{scen}", ["start", "python"], scen, "real")
    add("start.python.running.force", ["start", "-f", "python"], "running", "real")
    add("start.noargs", ["start"], "images", "real")
    add("start.unknown", ["start", "nosuchvm"], "images", "real")
    add("start.alias.py", ["start", "py"], "images", "real")
    add("start.multi", ["start", "python", "go"], "images", "real")
    add("start.default", ["start", "default"], "images", "real")
    add("start.cluster", ["start", "web"], "cluster", "real")
    add("start.quiet", ["-q", "start", "python"], "images", "real")
    for scen in ("images", "running"):
        add(f"stop.python.{scen}", ["stop", "python"], scen, "real")
    add("stop.noargs", ["stop"], "running", "real")
    add("stop.unknown", ["stop", "nosuchvm"], "running", "real")
    add("stop.default", ["stop", "default"], "running", "real")
    add("stop.force", ["stop", "-f", "python"], "running", "real")
    add("restart.python.running", ["restart", "python"], "running", "real")
    add("restart.noargs", ["restart"], "running", "real")
    add("restart.unknown", ["restart", "nosuchvm"], "running", "real")
    for verb in ("remove", "rm", "delete"):
        add(f"{verb}.python.running", [verb, "python"], "running", "real")
    add("remove.python.images", ["remove", "python"], "images", "real")
    add("remove.unknown", ["remove", "nosuchvm"], "images", "real")
    add("remove.noargs", ["remove"], "images", "real")
    for scen in ("empty", "images"):
        add(f"create.python.{scen}", ["create", "python"], scen, "real")
    add("rebuild.python.images", ["rebuild", "python"], "images", "real")
    add("rebuild.python.nocache", ["rebuild", "python", "--no-cache"], "images", "real")
    add("create.noargs", ["create"], "images", "real")

    # ---- inline, no docker: port / help / unknown ------------------------------------
    add("port.python", ["port", "python"], "images", "real")
    add("port.alias", ["port", "py"], "images", "real")
    add("port.unknown", ["port", "nosuchvm"], "images", "real")
    add("port.noargs", ["port"], "images", "real")
    for h in ("help", "-h", "--help"):
        add(f"help.{h}", [h], "images", "real")
    add("router.noargs", [], "images", "real")
    add("router.unknown", ["frobnicate"], "images", "real")

    # ---- Layer A: router contract for every delegated command ------------------------
    variants = [("noargs", []), ("alias", ["python"]), ("cluster", ["web"]),
                ("default", ["default"]), ("all", ["all"]), ("unknown", ["nosuchvm"]),
                ("force", ["-f", "python"]), ("quiet", ["-q", "python"]),
                ("optflag", ["--opt", "python"]), ("multi", ["python", "go", "postgres"])]
    cmds = ["init", "foundling", "path-of-the-foundling", "nuke", "ssh-setup", "ssh-sync",
            "ssh-agent-setup", "list", "add", "uninstall", "validate", "prune", "rebuild-cache",
            "sync-version", "sync-context", "audit", "check-tetrad", "spine-check", "heal",
            "info", "ps", "status", "inspect", "logs", "images", "networks", "stats", "health",
            "cluster", "vision", "matrix-audit", "matrix-rebuild"]
    for c in cmds:
        for vname, vargs in variants:
            add(f"route.{c}.{vname}", [c] + vargs, "cluster", "stub")
    # commands with a target-then-command shape
    for c in ("exec", "enter", "ssh"):
        add(f"route.{c}.noargs", [c], "cluster", "stub")
        add(f"route.{c}.vm", [c, "python"], "cluster", "stub")
        add(f"route.{c}.vmcmd", [c, "python", "ls", "-la", "/tmp"], "cluster", "stub")
        add(f"route.{c}.cluster", [c, "web"], "cluster", "stub")
        add(f"route.{c}.force", [c, "-f", "python", "ls"], "cluster", "stub")
    add("route.dns-check.noargs", ["dns-check"], "cluster", "stub")
    add("route.dns-check.pair", ["dns-check", "python", "go"], "cluster", "stub")
    # exit-code propagation from a delegate
    for c in ("list", "health", "ps", "info"):
        add(f"rc.{c}.3", [c, "python"], "cluster", "stub", {"STUB_DELEGATE_RC": "3"})
    return cases

# --------------------------------------------------------------------------------------
# Running one case
# --------------------------------------------------------------------------------------
def snapshot(root, skip_dirs=("logs", ".git")):
    out = {}
    for p in root.rglob("*"):
        if p.is_dir() or p.is_symlink():
            continue
        rel = p.relative_to(root)
        if rel.parts and rel.parts[0] in skip_dirs:
            continue
        try:
            out[str(rel)] = hashlib.sha1(p.read_bytes()).hexdigest()
        except OSError:
            out[str(rel)] = "unreadable"
    return out

def diff_snap(a, b):
    return {"added": sorted(set(b) - set(a)),
            "removed": sorted(set(a) - set(b)),
            "modified": sorted(k for k in set(a) & set(b) if a[k] != b[k])}

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\\033\[[0-9;?]*[A-Za-z]")
SPIN = re.compile("[\u2800-\u28ff]")
TS = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d{4}")
# ssh-keygen prints a fresh fingerprint + randomart on every key generation (random by design).
FPR = re.compile(r"SHA256:[A-Za-z0-9+/=]{20,}")
ART_EDGE = re.compile(r"^\+-{2,}.*-{2,}\+$")
ART_ROW = re.compile(r"^\|[ .o+=*BOX@%&#/^SE]{17}\|$")
def normalize(text, subs):
    t = text.replace("\r", "\n")
    t = ANSI.sub("", t)
    t = SPIN.sub("", t)
    t = TS.sub("<TS>", t)
    for real, token in subs:
        t = t.replace(real, token)
    # zsh error prefixes carry a source line number (e.g. "<ROOT>/bin/vde:shift:461:"); line numbers
    # are refactoring noise, so they are masked. The file, builtin and message text are still compared.
    t = re.sub(r"(\bbin/[A-Za-z0-9_.-]+:[A-Za-z_]+):\d+:", r"\1:<LN>:", t)
    t = FPR.sub("SHA256:<FP>", t)
    t = re.sub(r"\bvde@[\w.-]+", "vde@vm", t)   # ssh-keygen comment carries the host name
    t = "\n".join(ln for ln in t.split("\n") if not (ART_EDGE.match(ln.strip()) or ART_ROW.match(ln.strip())))
    t = re.sub(r"\b(\d+)ms\b", "<N>ms", t)
    t = re.sub(r"\bPID \d+", "PID <N>", t)
    lines = [ln.rstrip() for ln in t.split("\n")]
    lines = [ln.strip() if ln.strip() == "" else ln for ln in lines]
    out = []
    for ln in lines:                      # drop blanks and collapse immediate repeats
        if ln == "" or (out and out[-1] == ln):
            continue
        out.append(ln)
    return out

def run_case(case, template, stubbin, keep=False):
    work = pathlib.Path(tempfile.mkdtemp(prefix="vdechar-", dir=os.environ.get("CHAR_TMP")))
    try:
        root, home, state = work / "repo", work / "home", work / "state"
        shutil.copytree(template, root, symlinks=True)
        home.mkdir(); state.mkdir()
        scenario(case["scenario"], root, state)
        if case["mode"] == "stub":
            for d in DELEGATES:
                p = root / "bin" / d
                p.write_text(DELEGATE_STUB); p.chmod(0o755)
        before_repo, before_home = snapshot(root), snapshot(home)
        env = {"HOME": str(home), "PATH": f"{stubbin}:/usr/local/bin:/usr/bin:/bin{EXTRA_PATH}",
               "TERM": "dumb", "LC_ALL": "C.UTF-8", "TZ": "UTC", "STUB_STATE": str(state),
               "USER": "charuser"}
        env.update(case["env"])
        try:
            r = subprocess.run(["zsh", str(root / "bin" / "vde"), *case["args"]], env=env,
                               cwd=str(work), capture_output=True, text=True, timeout=TIMEOUT,
                               stdin=subprocess.DEVNULL, errors="replace")
            rc, so, se = r.returncode, r.stdout, r.stderr
        except subprocess.TimeoutExpired as e:
            rc, so, se = "TIMEOUT", (e.stdout or b"").decode(errors="replace") if isinstance(e.stdout, bytes) else (e.stdout or ""), "timeout"
        subs = [(str(root), "<ROOT>"), (str(home), "<HOME>"), (str(work), "<WORK>")]
        dlog = state / "docker.log"
        docker = [ln for ln in (dlog.read_text().splitlines() if dlog.exists() else [])]
        return {
            "id": case["id"], "args": case["args"], "scenario": case["scenario"],
            "mode": case["mode"], "env": case["env"], "exit_code": rc,
            "stdout": normalize(so, subs), "stderr": normalize(se, subs),
            "docker_calls": [normalize(ln, subs)[0] if normalize(ln, subs) else ln for ln in docker],
            "repo_changes": diff_snap(before_repo, snapshot(root)),
            "home_changes": diff_snap(before_home, snapshot(home)),
            "final_fake_state": {n: (state / n).read_text().split() if (state / n).exists() else []
                                 for n in ("containers", "running", "images")},
        }
    finally:
        if not keep:
            shutil.rmtree(work, ignore_errors=True)

# --------------------------------------------------------------------------------------
# Template + orchestration
# --------------------------------------------------------------------------------------
def make_stubbin(dirpath):
    dirpath.mkdir(parents=True, exist_ok=True)
    for name, body in (("docker", DOCKER_STUB), ("uptime", UPTIME_STUB), ("df", DF_STUB)):
        p = dirpath / name; p.write_text(body); p.chmod(0o755)

_IGNORE = (".git", "__pycache__", ".venv", "venv", "node_modules", "logs", ".locks", ".cache", ".docker-state", ".env")

def copy_clean(src, dst):
    """Copy a repo into a throwaway tree WITHOUT local state.
    In a git checkout only tracked plus untracked-but-not-ignored files are copied, so ignored files such as .env,
    local ssh keys or runtime data can never leak into a case. (vde-testing/ and .handoff/ are skipped.)
    Outside git, falls back to a copy that skips well-known local-state names."""
    src, dst = pathlib.Path(src), pathlib.Path(dst)
    dst.mkdir(parents=True, exist_ok=True)
    if (src / ".git").exists():
        r = subprocess.run(["git", "-C", str(src), "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                           capture_output=True)
        if r.returncode == 0 and r.stdout:
            for rel in r.stdout.decode().split("\0"):
                if not rel or rel.startswith(("vde-testing/", ".handoff/")):
                    continue
                s_, d_ = src / rel, dst / rel
                if s_.is_symlink():
                    d_.parent.mkdir(parents=True, exist_ok=True)
                    if not d_.exists() and not d_.is_symlink(): os.symlink(os.readlink(s_), d_)
                elif s_.is_file():
                    d_.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(s_, d_)
            return
    shutil.copytree(src, dst, symlinks=True, dirs_exist_ok=True, ignore=shutil.ignore_patterns(*_IGNORE))

def make_template(repo, tmp):
    tpl = tmp / "template"
    copy_clean(repo, tpl)
    # Warm the VM-types cache so every case starts from identical state.
    home, state = tmp / "warm-home", tmp / "warm-state"; home.mkdir(); state.mkdir()
    env = {"HOME": str(home), "PATH": f"{tmp/'stubbin'}:/usr/local/bin:/usr/bin:/bin{EXTRA_PATH}",
           "TERM": "dumb", "LC_ALL": "C.UTF-8", "TZ": "UTC", "STUB_STATE": str(state)}
    subprocess.run(["zsh", str(tpl / "bin" / "vde"), "help"], env=env, cwd=str(tmp),
                   capture_output=True, timeout=TIMEOUT, stdin=subprocess.DEVNULL)
    shutil.rmtree(tpl / "logs", ignore_errors=True)
    return tpl

def run_all(repo, only, workers):
    cases = [c for c in build_cases() if not only or only in c["id"]]
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="vdechar-tpl-", dir=os.environ.get("CHAR_TMP")))
    try:
        make_stubbin(tmp / "stubbin")
        tpl = make_template(pathlib.Path(repo).resolve(), tmp)
        with cf.ThreadPoolExecutor(max_workers=workers) as ex:
            results = list(ex.map(lambda c: run_case(c, tpl, tmp / "stubbin"), cases))
        return results
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

def manifest(repo):
    def sh(cmd):
        try: return subprocess.run(cmd, shell=True, capture_output=True, text=True).stdout.strip()
        except Exception: return "?"
    return {"repo_commit": sh(f"git -C {repo} rev-parse HEAD"),
            "zsh": sh("zsh --version"), "jq": sh("jq --version"),
            "note": "load average, disk usage and docker are faked; see DOCKER_STUB etc."}

def write_golden(results, repo):
    GOLDEN.mkdir(exist_ok=True)
    for r in results:
        (GOLDEN / f"{r['id']}.json").write_text(json.dumps(r, indent=1, sort_keys=True) + "\n")
    (GOLDEN / "_manifest.json").write_text(json.dumps(manifest(repo), indent=1) + "\n")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["record", "check", "stable", "list"])
    ap.add_argument("--repo"); ap.add_argument("--only", default="")
    ap.add_argument("--workers", type=int, default=2)
    a = ap.parse_args()
    if a.mode == "list":
        for c in build_cases(): print(c["id"], c["mode"], c["scenario"], " ".join(c["args"]))
        return 0
    if not a.repo: ap.error("--repo is required")
    if a.mode == "record":
        res = run_all(a.repo, a.only, a.workers); write_golden(res, a.repo)
        print(f"recorded {len(res)} cases -> {GOLDEN}")
        print("exit codes:", {str(k): sum(1 for r in res if r['exit_code'] == k)
                              for k in sorted({r['exit_code'] for r in res}, key=str)})
        return 0
    if a.mode == "stable":
        r1 = run_all(a.repo, a.only, a.workers); r2 = run_all(a.repo, a.only, a.workers)
        bad = [x["id"] for x, y in zip(r1, r2) if x != y]
        print(f"{len(r1) - len(bad)}/{len(r1)} cases identical across two runs")
        for b in bad: print("  NONDETERMINISTIC:", b)
        return 1 if bad else 0
    res = run_all(a.repo, a.only, a.workers)       # check
    failed = 0
    for r in res:
        gp = GOLDEN / f"{r['id']}.json"
        if not gp.exists():
            print(f"[NEW ] {r['id']} (no golden)"); failed += 1; continue
        g = json.loads(gp.read_text())
        if g == json.loads(json.dumps(r)):
            continue
        failed += 1
        print(f"[DIFF] {r['id']}")
        a_ = json.dumps(g, indent=1, sort_keys=True).splitlines()
        b_ = json.dumps(r, indent=1, sort_keys=True).splitlines()
        for ln in list(difflib.unified_diff(a_, b_, "golden", "now", lineterm="", n=1))[:40]:
            print("   ", ln)
    print(f"{len(res) - failed}/{len(res)} cases match golden")
    return 1 if failed else 0

if __name__ == "__main__":
    sys.exit(main())
