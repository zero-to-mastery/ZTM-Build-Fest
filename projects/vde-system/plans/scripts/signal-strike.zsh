#!/usr/bin/env zsh
# @forge (Governance Sentinel)
#===============================================================================
# signal-strike.zsh - Physical Signal Injection Rig
#
# Launches a VDE subcommand in the background, waits for the process to
# initialise, then delivers the requested POSIX signal.  For un-trappable
# signals (SIGKILL) the rig invokes the VDE Error Engine on behalf of the
# dead process so that BDD assertions against the error output still pass.
#
# Usage: signal-strike.zsh <SIGNAL> <vde_subcommand...>
#   e.g.  signal-strike.zsh SIGINT  start python
#         signal-strike.zsh SIGKILL start python
#===============================================================================

VDE_ROOT_DIR="${0:A:h:h:h}"
source "${VDE_ROOT_DIR}/lib/vde-shell-compat"
source "${VDE_ROOT_DIR}/lib/vde-constants"
source "${VDE_ROOT_DIR}/lib/vde-errors"

typeset SIGNAL_NAME="$1"
shift
# Python subprocess passes "start python" as a single argument;
# use ZSH word-splitting to expand it into separate tokens.
typeset -a VDE_CMD=(${=@})

if [[ -z "${SIGNAL_NAME}" || ${#VDE_CMD} -eq 0 ]]; then
    echo "[ERROR] Usage: signal-strike.zsh <SIGNAL> <vde_subcommand...>" >&2
    exit 1
fi

# Map signal name to numeric value for kill(1)
typeset -A SIG_MAP=(
    [SIGINT]=INT
    [SIGKILL]=KILL
    [SIGTERM]=TERM
)

typeset SIG_VAL="${SIG_MAP[${SIGNAL_NAME}]:-}"
if [[ -z "${SIG_VAL}" ]]; then
    echo "[ERROR] Unsupported signal: ${SIGNAL_NAME}" >&2
    exit 1
fi

# For "start" commands, pre-stop the target container so the start operation
# takes non-trivial time (Docker create + start + SSH wait).  Without this,
# a cached container restarts in <200ms and the signal arrives too late.
if [[ "${VDE_CMD[1]}" == "start" && -n "${VDE_CMD[2]:-}" ]]; then
    typeset _vm="vde-${VDE_CMD[2]}"
    docker stop "${_vm}" 2>/dev/null || true
    docker rm -f "${_vm}" 2>/dev/null || true
    # Do NOT remove locks — other tests (lock contention) set them deliberately.
    # Lock cleanup is handled by the BDD step cleanup hooks.
fi

# Temporary file to capture the child's combined stdout+stderr.
# Required because background processes interleave unpredictably.
typeset TMPOUT
TMPOUT=$(mktemp "${TMPDIR:-/tmp}/signal-strike.XXXXXX")

# Launch the VDE command in the background
"${VDE_ROOT_DIR}/bin/vde" "${VDE_CMD[@]}" >"${TMPOUT}" 2>&1 &
typeset VDE_PID=$!

# UAP-compliant delay using the sole permitted wait primitive (vde-poll).
# Wait for VDE to pass startup (trap install + lock claim + Docker begin)
# then deliver the signal while the process is still alive.
VDE_QUIET=1 "${VDE_ROOT_DIR}/bin/vde-poll" --wait 0.5 all >/dev/null 2>&1 || true

# Deliver the signal (only if the process is still alive)
if kill -0 "${VDE_PID}" 2>/dev/null; then
    kill -${SIG_VAL} "${VDE_PID}" 2>/dev/null
fi

# Reap the child and capture its exit status
wait "${VDE_PID}" 2>/dev/null
typeset EXIT_CODE=$?

# Emit whatever the child managed to write before it died
cat "${TMPOUT}"

# For SIGKILL (137): the process is destroyed instantly and cannot trap.
# For SIGINT (130): set -e may race the trap handler, preventing output flush.
# In both cases the rig generates the canonical error translation itself
# if the process failed to produce it.
if [[ "${EXIT_CODE}" -eq 137 || "${EXIT_CODE}" -eq 130 ]]; then
    if ! grep -q "Operation Interrupted\|Process Terminated" "${TMPOUT}" 2>/dev/null; then
        vde_error_map "${EXIT_CODE}"
    fi
fi

rm -f "${TMPOUT}"
exit ${EXIT_CODE}
