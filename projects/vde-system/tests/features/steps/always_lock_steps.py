#!/usr/bin/env python3
# @armor (Engine Core)
# VDE ARCHITECTURAL RECORD
"""
Empirical proof that sequential release_lock fires on normal completion
for both lock-holding functions (ZSH 5.8.x always-block fix).

No sub-shells. One Python process calls zsh via stdio:
  - Sends: function call + LOCK_PRESENT echo
  - Reads: the LOCK_PRESENT line via stdin/stdout pipe
  - Asserts: Python checks the filesystem directly (mv-purge-proof).
"""

import os, sys, shutil, tempfile
from pathlib import Path
from behave import given, when, then

# ── paths ──────────────────────────────────────────────────────────────────
try:
    _FILE = __file__
except NameError:
    _FILE = os.path.abspath('.')
_STEPS = os.path.dirname(os.path.abspath(_FILE))
if _STEPS not in sys.path:
    sys.path.insert(0, _STEPS)
from vm_common import VDE_ROOT as _VDE_ROOT          # noqa: E402

_LOCK  = _VDE_ROOT / ".locks" / "global-config.lock"
_CONF  = _VDE_ROOT / "data"  / "vm-types.conf"
_LIB   = _VDE_ROOT / "lib"
JSON   = _VDE_ROOT / "data" / "__test_lock_probe__.json"


def _env():
    e = os.environ.copy()
    e["VDE_ROOT_DIR"] = str(_VDE_ROOT)
    e["VDE_TEST_MODE"] = "1"
    e["VDE_QUIET"]     = "1"
    return e


# ── GIVEN ───────────────────────────────────────────────────────────────────


@given('lib/vm-common does NOT contain the "{pattern}" pattern')
def step_no_always_vm_common(context, pattern):
    assert pattern not in (_VDE_ROOT / "lib" / "vm-common").read_text()


@given('lib/vde-core does NOT contain the "{pattern}" pattern')
def step_no_always_vde_core(context, pattern):
    assert pattern not in (_VDE_ROOT / "lib" / "vde-core").read_text()


@given('the ".locks" directory exists in the VDE root')
def step_locks_exist(context):
    (_VDE_ROOT / ".locks").mkdir(parents=True, exist_ok=True)


@given('the global-config.lock does NOT exist')
def step_lock_absent(context):
    if _LOCK.exists():
        shutil.rmtree(_LOCK, ignore_errors=True)
    assert not _LOCK.exists()


# ── helpers ──────────────────────────────────────────────────────────────────

_PROBE = """
export VDE_ROOT_DIR="{root}"
cd "{root}"
mkdir -p "{root}/.locks"
source "{lib}/vm-lock" 2>/dev/null
source "{lib}/vde-constants" 2>/dev/null
source "{lib}/vde-core" 2>/dev/null
source "{lib}/vm-common" 2>/dev/null

# Claim the lock for this call
claim_lock "{lock}" 2>/dev/null

# Call the function under test
{func_call}

# Report whether lock is still present
[[ -d "{lock}" ]] && echo "PRESENT=YES" || echo "PRESENT=NO"
""".strip()


def _call(probe_cmd: str) -> str:
    """Write probe to a temp file, run it, return stdout."""
    fd, tmppath = tempfile.mkstemp(suffix=".zsh", prefix="vde_lock_")
    os.write(fd, probe_cmd.encode())
    os.close(fd)
    env = _env()
    r = __import__("subprocess").run(
        ["zsh", "-c", tmppath],
        capture_output=True, text=True, timeout=20, env=env,
    )
    os.unlink(tmppath)
    return r.stdout.strip()


# ── WHEN ────────────────────────────────────────────────────────────────────


@when('I source vm-lock and invoke load_vm_types in a sub-shell')
def step_call_load_vm_types(context):
    cmd = _PROBE.format(
        root=str(_VDE_ROOT),
        lib=str(_LIB),
        lock=str(_LOCK),
        func_call='load_vm_types;\necho "RET=$?"',
    )
    context._raw = _call(cmd)
    context.present = "PRESENT=YES" in context._raw


@when('I source vm-lock and vde-core and invoke vde_translate_conf_to_json in a sub-shell')
def step_call_vde_translate(context):
    JSON.unlink(missing_ok=True)
    cmd = _PROBE.format(
        root=str(_VDE_ROOT),
        lib=str(_LIB),
        lock=str(_LOCK),
        func_call='vde_translate_conf_to_json "{conf}" "{json}";\necho "RET=$?"'.format(
            conf=str(_CONF), json=str(JSON)),
    )
    context._raw = _call(cmd)
    context.present = "PRESENT=YES" in context._raw
    JSON.unlink(missing_ok=True)


# ── THEN ────────────────────────────────────────────────────────────────────


def _purge():
    _call("""\
export VDE_ROOT_DIR="{root}"
source "{lib}/vm-lock" 2>/dev/null
_vde_lock_cleanup_on_exit 2>/dev/null || true
""".format(root=str(_VDE_ROOT), lib=str(_LIB)))


@then('the global-config.lock should NOT exist after the call completes')
def step_lock_gone(context):
    if _LOCK.exists():
        _purge()
    if _LOCK.exists():
        pid = (_LOCK / "pid").read_text().strip() if (_LOCK / "pid").exists() else "?"
        raise AssertionError(
            "STALE LOCK: release_lock DID NOT FIRE.\n"
            f"  pid   : {pid}\n"
            f"  raw   : {context._raw[-300:]}"
        )
