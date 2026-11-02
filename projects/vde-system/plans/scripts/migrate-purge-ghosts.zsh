#!/usr/bin/env zsh
# @forge (Migration Staging Tool — BTO Ghost Purge Standardization)
# Replaces inline apt-get clean + rm -rf with canonical vde_purge_ghosts call.
# Usage: zsh plans/scripts/migrate-purge-ghosts.zsh [--dry-run]

setopt PIPE_FAIL NO_UNSET

typeset -r SCRIPT_PATH="${0:A}"
typeset -r VDE_ROOT="${SCRIPT_PATH:h:h:h}"
typeset -r SETUP_DIR="${VDE_ROOT}/scripts/setup"
typeset -r VDE_ROOT_EXPORT='export VDE_ROOT_DIR="${VDE_ROOT_DIR:-${0:a:h:h:h}}"'
typeset -r SOURCE_GUARD='[[ -f "${VDE_ROOT_DIR}/lib/vde-core" ]] && source "${VDE_ROOT_DIR}/lib/vde-core"'
typeset -r PURGE_CALL="vde_purge_ghosts"
typeset dry_run=0

[[ "${1:-}" == "--dry-run" ]] && dry_run=1

integer count=0
integer skipped=0
integer errors=0

print "=== BTO Ghost Purge Migration (Rule 12.5) ==="
print "Root: ${VDE_ROOT}"
print "Mode: $(( dry_run )) && print DRY-RUN || print LIVE"
print ""

for script in "${SETUP_DIR}"/*-init.zsh; do
    [[ -f "${script}" ]] || continue
    local name="${script:t}"

    if grep -q "vde_purge_ghosts" "${script}"; then
        print "  [SKIP]     ${name}"
        (( skipped++ ))
        continue
    fi

    if ! grep -q "apt-get clean" "${script}"; then
        print "  [NO-OP]    ${name} — no apt-get clean found"
        (( skipped++ ))
        continue
    fi

    local -a lines=()
    local -a out=()
    integer skip=0
    while IFS= read -r line || [[ -n "${line}" ]]; do
        lines+=("${line}")
    done < "${script}"

    for line in "${lines[@]}"; do
        # Consume the rm -rf line that follows apt-get clean
        if (( skip )); then
            if [[ "${line}" == "rm -rf /var/lib/apt/lists/"* ]]; then
                skip=0
                continue
            fi
            skip=0
        fi

        # Update PURGING THE GHOSTS comment — append Rule 12.5 annotation
        if [[ "${line}" == *"PURGING THE GHOSTS"* && "${line}" != *"Rule 12.5"* ]]; then
            out+=("${line} (Rule 12.5)")
            continue
        fi

        # Replace apt-get clean with canonical VDE_ROOT_DIR resolution + sourcing + vde_purge_ghosts
        if [[ "${line}" == *"apt-get clean"* ]]; then
            out+=("${VDE_ROOT_EXPORT}")
            out+=("${SOURCE_GUARD}")
            out+=("${PURGE_CALL}")
            skip=1
            continue
        fi

        out+=("${line}")
    done

    if (( dry_run )); then
        print "  [DRY-RUN]  ${name}"
    else
        if { for o in "${out[@]}"; do print -r -- "${o}"; done } > "${script}"; then
            print "  [MIGRATED] ${name}"
            (( count++ ))
        else
            print "  [ERROR]    ${name} — write failed"
            (( errors++ ))
        fi
    fi
done

print ""
print "=== Summary ==="
if (( dry_run )); then
    print "DRY-RUN complete. No files modified."
else
    print "Migrated : ${count}"
    print "Skipped  : ${skipped}"
    print "Errors   : ${errors}"
fi
