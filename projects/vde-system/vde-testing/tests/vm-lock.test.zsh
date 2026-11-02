#!/usr/bin/env zsh
# Gap-filling tests: lib/vm-lock (atomic mkdir lock + FIFO ticket queue)
# No unit test exists for this library; it is only exercised through BDD features.
: ${VDE_ROOT_DIR:?set VDE_ROOT_DIR to the vde-system checkout}
source "${0:A:h}/_harness.zsh"
source "${VDE_ROOT_DIR}/lib/vde-shell-compat"
source "${VDE_ROOT_DIR}/lib/vde-constants"
source "${VDE_ROOT_DIR}/lib/vm-common"
source "${VDE_ROOT_DIR}/lib/vm-lock"

unset VDE_NO_LOCK
typeset SANDBOX="$(mktemp -d)"
trap 'rm -rf "${SANDBOX}"' EXIT

echo "== is_process_alive"
is_process_alive $$;        assert_rc "own pid is alive" 0 $?
is_process_alive 99999999;  assert_rc "absurd pid is dead" 1 $?
is_process_alive "";        assert_rc "empty pid rejected" 1 $?
is_process_alive "abc";     assert_rc "non-numeric pid rejected" 1 $?
is_process_alive "12;id";   assert_rc "pid with metacharacters rejected" 1 $?

echo "== claim / release basic cycle"
L="${SANDBOX}/basic.lock"
claim_lock "$L" 2>/dev/null;              assert_rc "claim succeeds" 0 $?
[[ -d "$L" ]];                            assert_rc "lock directory exists" 0 $?
assert_eq "pid file starts with our pid" "$$" "$(cut -d: -f1 < "$L/pid")"
assert_eq "pid file has PID:PGID:TS (3 fields)" 3 "$(awk -F: '{print NF}' < "$L/pid")"
[[ -d "${L}.queue" && -n "$(ls -A "${L}.queue")" ]]; assert_rc "ticket registered in queue" 0 $?
release_lock "$L";                        assert_rc "release returns 0" 0 $?
[[ ! -e "$L" ]];                          assert_rc "lock directory removed" 0 $?
[[ ! -e "${L}.queue" ]];                  assert_rc "empty queue directory removed" 0 $?

echo "== re-entrancy (depth counting)"
L="${SANDBOX}/reentrant.lock"
claim_lock "$L" 2>/dev/null; claim_lock "$L" 2>/dev/null
assert_eq "depth is 2 after two claims" 2 "${VDE_LOCK_DEPTH[$L]}"
release_lock "$L"
[[ -d "$L" ]];                            assert_rc "first release keeps lock held" 0 $?
assert_eq "depth back to 1" 1 "${VDE_LOCK_DEPTH[$L]}"
release_lock "$L"
[[ ! -e "$L" ]];                          assert_rc "second release frees lock" 0 $?
assert_eq "depth entry cleared" "" "${VDE_LOCK_DEPTH[$L]:-}"

echo "== VDE_NO_LOCK=1 bypass"
L="${SANDBOX}/bypass.lock"
VDE_NO_LOCK=1 claim_lock "$L";            assert_rc "claim bypassed" 0 $?
[[ ! -e "$L" ]];                          assert_rc "no lock dir created when bypassed" 0 $?

echo "== release of a lock we never held"
release_lock "${SANDBOX}/never.lock";     assert_rc "release of unknown lock is harmless" 0 $?

echo "== stale lock busting (dead owner, older than 10s grace)"
L="${SANDBOX}/stale.lock"
mkdir -p "$L"; echo "99999999:1:$(( $(date +%s) - 60 ))" > "$L/pid"
claim_lock "$L" 2>/dev/null;              assert_rc "claim succeeds over stale lock" 0 $?
assert_eq "ownership transferred to us" "$$" "$(cut -d: -f1 < "$L/pid")"
release_lock "$L"

echo "== grace period: dead owner but lock < 10s old is NOT busted"
L="${SANDBOX}/grace.lock"
mkdir -p "$L"; echo "99999999:1:$(date +%s)" > "$L/pid"
# claim would contend for ~30 cycles; cap it and check the lock was left alone
( VDE_ROOT_DIR="${VDE_ROOT_DIR}" timeout 4 zsh -c "
    source '${VDE_ROOT_DIR}/lib/vde-shell-compat'; source '${VDE_ROOT_DIR}/lib/vde-constants'
    source '${VDE_ROOT_DIR}/lib/vm-common'; source '${VDE_ROOT_DIR}/lib/vm-lock'
    claim_lock '$L'" >/dev/null 2>&1 )
assert_eq "fresh dead-owner lock still held by original pid" 99999999 "$(cut -d: -f1 < "$L/pid")"

finish
