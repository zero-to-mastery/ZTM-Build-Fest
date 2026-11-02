#!/usr/bin/env zsh
# @forge (Governance Sentinel)
#===============================================================================
# vde-security-audit.zsh - Continuous CodeQL & Privacy Monitoring
#===============================================================================
typeset _zsh_pure=${(%):-%x}

# 1. Dynamic Repo Discovery (Rule 4 Alignment)
typeset _repo=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)
if [[ -z "${_repo}" ]]; then
    echo "[SECURITY] Warning: Could not determine repository name. Skipping CodeQL audit."
else
    # 2. CodeQL Monitoring
    echo "[SECURITY] Auditing CodeQL Alerts for ${_repo}..."
    local _alerts=$(gh api "repos/${_repo}/code-scanning/alerts" --params 'state=open' -q '.[] | select(.rule.security_severity_level == "high" or .rule.security_severity_level == "critical") | .html_url' 2>/dev/null)

    if [[ -n "${_alerts}" ]]; then
        echo -e "\033[0;31m[CRITICAL] Unremediated High/Critical CodeQL Alerts Found:\033[0m"
        echo "${_alerts}"
        exit 1
    fi
    echo "[SECURITY] CodeQL High/Critical Audit: PASS"
fi

# 3. Privacy Leak Guard (Absolute Path Detection)
echo "[SECURITY] Scanning for Absolute Path Leaks..."
# Exclude dirs and files shared by both the counting and display grep passes
typeset -a _scan_exclude_dirs=(.git .cache .claude .tmp.driveupload .tmp.drivedownload logs node_modules __pycache__ SKILLS output projects)
typeset -a _scan_exclude_files=(vde-security-audit.zsh vde-root-guard README.md)
typeset -a _grep_excludes=()
for _d in "${_scan_exclude_dirs[@]}"; do _grep_excludes+=(--exclude-dir="${_d}"); done
for _f in "${_scan_exclude_files[@]}"; do _grep_excludes+=(--exclude="${_f}"); done
_grep_excludes+=(--exclude="*.pdf")

if grep -rq "/Users/" . "${_grep_excludes[@]}"; then
    echo -e "\033[0;31m[CRITICAL] Absolute Path Leaks Detected in Workspace!\033[0m"
    grep -r "/Users/" . "${_grep_excludes[@]}" | head -n 5
    exit 1
fi
echo "[SECURITY] Privacy Leak Audit: PASS"

exit 0
