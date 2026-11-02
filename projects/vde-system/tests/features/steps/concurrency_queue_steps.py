#!/usr/bin/env python3
# @forge (Governance Sentinel)
# VDE ARCHITECTURAL RECORD
import os
import subprocess
import time
import signal
from pathlib import Path
from behave import given, when, then
from vm_common import VDE_ROOT, run_vde_command, vde_sleep

# ZSH startup + 3-source ≈ 102ms; 200ms ensures deterministic FIFO ordering
ARRIVAL_INTERVAL_SECONDS = 0.200

@given('the registry is reconciled')
def step_reconcile_registry(context):
    run_vde_command("rebuild-cache")

@when('I launch 10 simultaneous "start python" requests at {interval:f}s intervals')
def step_launch_simultaneous_requests(context, interval):
    # We use a test script that sources the lock library and logs timestamps
    test_script = VDE_ROOT / "plans" / "scripts" / "test_fifo.zsh"
    test_script.parent.mkdir(parents=True, exist_ok=True)
    log_file = VDE_ROOT / "plans" / "scripts" / "fifo_test.log"
    if log_file.exists():
        log_file.unlink()
        
    test_script.write_text("""#!/usr/bin/env zsh
# @shared-law (FIFO Lock Empirical Test Harness — Concurrency Proof)
VDE_ROOT_DIR="${VDE_ROOT_DIR:-${0:A:h:h:h}}"
# depth: plans/scripts/<name>.zsh is 3 levels below VDE root (plans/scripts → plans → VDE)

# Parse args and log ARRIVE *before* heavy library sourcing.
# Library sourcing has ~102ms mean but high variance; logging first ensures
# the 200ms launch stagger produces deterministic FIFO arrival ordering.
LOCK_NAME="$1"
WAIT_TIME="$2"
ID="$3"
typeset LOG_FILE="${VDE_ROOT_DIR}/plans/scripts/fifo_test.log"

echo "ARRIVE:$ID:$(date +%s.%N)" >> "${LOG_FILE}"

source "${VDE_ROOT_DIR}/lib/vm-common"
source "${VDE_ROOT_DIR}/lib/vde-core"
source "${VDE_ROOT_DIR}/lib/vm-lock"
if claim_lock "$LOCK_NAME"; then
    echo "ACQUIRE:$ID:$(date +%s.%N)" >> "${LOG_FILE}"
    zmodload zsh/zselect && zselect -t 50
    release_lock "$LOCK_NAME"
    echo "RELEASE:$ID:$(date +%s.%N)" >> "${LOG_FILE}"
else
    echo "FAIL:$ID:$(date +%s.%N)" >> "${LOG_FILE}"
fi
""")
    test_script.chmod(0o755)
    
    lock_path = VDE_ROOT / ".locks" / "vms" / "fifo-test.lock"
    if lock_path.exists():
        import shutil
        shutil.rmtree(lock_path)
        
    context.procs = []
    arrival_interval = interval
    for i in range(1, 11):
        p = subprocess.Popen(
            [str(test_script), str(lock_path), "0.5", str(i)],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            cwd=VDE_ROOT
        )
        context.procs.append(p)
        vde_sleep(arrival_interval)
        
    for p in context.procs:
        p.communicate()
        
    context.fifo_log = log_file.read_text()

@then('they should be served in the order they arrived')
def step_verify_fifo_order(context):
    lines = context.fifo_log.strip().split("\n")
    arrivals = [line.split(":")[1] for line in lines if line.startswith("ARRIVE")]
    acquisitions = [line.split(":")[1] for line in lines if line.startswith("ACQUIRE")]
    
    expected_order = [str(i) for i in range(1, 11)]
    assert arrivals == expected_order, f"Arrivals out of order: {arrivals}"
    assert acquisitions == arrivals, f"FIFO violated: served {acquisitions} but arrived {arrivals}. Log:\n{context.fifo_log}"

@then('the final state should be all requests completed successfully')
def step_verify_final_state(context):
    lines = context.fifo_log.strip().split("\n")
    releases = [line.split(":")[1] for line in lines if line.startswith("RELEASE")]
    assert len(releases) == 10, f"Not all locks released: {releases}"
