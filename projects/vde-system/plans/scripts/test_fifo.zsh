#!/usr/bin/env zsh
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
