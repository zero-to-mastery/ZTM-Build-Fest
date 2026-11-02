#!/usr/bin/env zsh
# @forge (Governance Sentinel)
#===============================================================================
# vde-enforce-uap.zsh - Universal Agent Protocol Enforcement (Hardened)
set -e
#
# Enforces the Strict Core Mandates from AGENTS.md:
# 1. Sovereign ZSH Purity (Shebang & Content)
# 2. Forbidden Patterns (No sleep, No bash-isms)
# 3. Structural Integrity (Mandatory Configs)
#===============================================================================

VDE_ROOT_DIR="${0:h:h}"

# 0. Technical Integrity Gate (Project 1 Dependency)
# The Forge cannot be lit without the Unyielding Tetrad.
if [[ -f "${VDE_ROOT_DIR}/bin/vde-check-tetrad.zsh" ]]; then
    "${VDE_ROOT_DIR}/bin/vde-check-tetrad.zsh" || exit 1
fi

# Parse flags
quiet=0
if [[ "${1}" == "--quiet" || "${1}" == "-q" ]]; then
    quiet=1
    shift
fi

# Counters for Verdict
errors=0
warnings=0

#===============================================================================
# GHOST ZONE CHECK (Zero-Tolerance)
#===============================================================================

# Rule 3 Enforcement: plans/ Subdirectory Lock
if [[ -d "plans" ]]; then
    for item in plans/*(N/); do
        local sub_name="${item:t}"
        if [[ "${sub_name}" != "scripts" && "${sub_name}" != "archive" ]]; then
            echo "\033[1;31m[CRITICAL FAILURE]\033[0m Ghost Zone 'plans/${sub_name}/' detected."
            echo "Protocol Violation: Rule 3 (Ghost Zone Prohibition)."
            echo "Purging unauthorized artifacts and halting session..."
            rm -rf "${item}"
            exit 1
        fi
    done
fi

# Mandatory config files (Mandate 0 & 14 integration)
MANDATORY_FILES=("AGENTS.md" "GEMINI.md" "MEMORY.md")

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 1. Check for mandatory config files [Mandate 0]
[[ $quiet -eq 0 ]] && echo -e "${GREEN}[UAP-START]${NC} Verifying mandatory configurations..."
for file in "${MANDATORY_FILES[@]}"; do
    if [[ ! -f "${VDE_ROOT_DIR}/${file}" ]]; then
        echo -e "${RED}[UAP-ERROR]${NC} Mandatory file missing: ${file}"
        errors=$((errors + 1))
    fi
done

# 2. The Audit Function (Deep Content Inspection)
audit_file_content() {
    local file=$1
    local first_line
    
    # Skip backup files explicitly
    if [[ "$file" == *.bak ]]; then
        return
    fi
    
    # Skip binary files
    if ! (file "$file" | grep -qE "text|JSON|XML|source"); then
        return
    fi
    
    # Mandate 24: Absolute Tagging Rule (Line 2 or 3)
    # Architectural tags can NEVER be on the first line.
    if head -n 1 "$file" | grep -qE "@armor|@forge|@shared-law"; then
        echo -e "${RED}[UAP-ERROR]${NC} Architectural tag found on line 1 of ${file#${VDE_ROOT_DIR}/}. Move to line 2 or 3."
        errors=$((errors + 1))
    fi

    # Support # (Shell/Python/INI), <!-- --> (XML/Markdown), " (JSON), // (JS/C), -- (SQL)
    # ZSH-native pattern matching for tag extraction
    local tag_found=$(sed -n '2,3p' "$file" | grep -E "^[[:space:]]*(#|<!--|//|\"|--|;)[[:space:]]*@(armor|forge|shared-law).*")
    if [[ -z "${tag_found}" ]]; then
        echo -e "${RED}[UAP-ERROR]${NC} Missing or invalid architectural tag in lines 2-3 of ${file#${VDE_ROOT_DIR}/}."
        echo "Expected Pattern: @armor|@forge|@shared-law (Functional Effect)"
        errors=$((errors + 1))
    fi

    # Only audit ZSH logic for scripts (skip data and documentation)
    if [[ "$file" == *.zsh || ( "$file" != *.* && $(file "$file" 2>/dev/null) == *"shell script"* ) ]]; then
        # Mandate 1: Sovereign Shebang Check (ZSH ONLY)
        read -r first_line < "$file"
        if [[ "${first_line}" != "#!/usr/bin/env zsh" && "${first_line}" != "#!/bin/zsh" ]]; then
            echo -e "${RED}[UAP-ERROR]${NC} Non-canonical ZSH shebang in ${file#${VDE_ROOT_DIR}/}. Expected #!/usr/bin/env zsh"
            errors=$((errors + 1))
        fi

        # Forbidden Pattern: Sleep Calls [CRITICAL FORBIDDEN PATTERNS]
        if grep -qE "\bsleep [0-9]+" "$file"; then
            echo -e "${RED}[UAP-ERROR]${NC} Forbidden 'sleep' found in ${file#${VDE_ROOT_DIR}/}. Use polling."
            errors=$((errors + 1))
        fi

        # Bash-ism: Single Brackets [CRITICAL FORBIDDEN PATTERNS]
        if grep -q " \[ " "$file" && ! grep -q " \[\[ " "$file"; then
             echo -e "${YELLOW}[UAP-WARN]${NC} Potential Bash-style '[' in ${file#${VDE_ROOT_DIR}/}. Use ZSH '[[ ]]'"
             warnings=$((warnings + 1))
        fi

        # Mandate 1: 0-indexed Arrays (Shibboleth) - ZSH ONLY
        if grep -q "\[0\]" "$file"; then
            echo -e "${RED}[UAP-ERROR]${NC} 0-indexed array found in ${file#${VDE_ROOT_DIR}/}. ZSH is 1-indexed."
            errors=$((errors + 1))
        fi

        # Mandate 1: "Fake ZSH" Detection (Checks for lack of expansion flags)
        if [[ $(wc -l < "$file") -gt 30 ]] && ! grep -q "\${(" "$file"; then
            echo -e "${YELLOW}[UAP-WARN]${NC} ${file#${VDE_ROOT_DIR}/} lacks ZSH parameter flags. Verify ZSH-native logic."
            warnings=$((warnings + 1))
        fi
    elif [[ "$file" == *.py ]]; then
        # Python Shebang Check
        read -r first_line < "$file"
        if [[ "${first_line}" != "#!/usr/bin/env python3" ]]; then
            echo -e "${RED}[UAP-ERROR]${NC} Non-canonical Python shebang in ${file#${VDE_ROOT_DIR}/}. Expected #!/usr/bin/env python3"
            errors=$((errors + 1))
        fi
        
        # Forbidden Pattern: Sleep Calls in Python (still applies to governance logic)
        if grep -qE "time\.sleep\(" "$file"; then
            echo -e "${RED}[UAP-ERROR]${NC} Forbidden 'sleep' found in Python script ${file#${VDE_ROOT_DIR}/}. Use polling."
            errors=$((errors + 1))
        fi
    fi
}

# 3. Directory Traversal Logic
check_dir() {
    local dir=$1
    if [[ ! -d "$dir" ]]; then return; fi
    
    # Skip archive directory
    if [[ "${dir}" == *"bin/archive" ]]; then
        return
    fi

    [[ $quiet -eq 0 ]] && echo -e "${GREEN}[UAP-CHECK]${NC} Auditing directory: ${dir#${VDE_ROOT_DIR}/}"
    # Use recursive glob (**) to audit all files in subdirectories
    for file in "${dir}"/**/*(N.); do
        # Skip files in archive subdirectories
        if [[ "$file" == *"bin/archive/"* ]]; then
            continue
        fi

        # Audit all files in these directories
        if [[ -f "$file" ]]; then
            audit_file_content "$file"
        fi
    done
}

# Run Audits on core directories
check_dir "${VDE_ROOT_DIR}/bin"
check_dir "${VDE_ROOT_DIR}/lib"
check_dir "${VDE_ROOT_DIR}/.gemini"
check_dir "${VDE_ROOT_DIR}/env-files"
check_dir "${VDE_ROOT_DIR}/scripts"
check_dir "${VDE_ROOT_DIR}/data"
check_dir "${VDE_ROOT_DIR}/docs"
check_dir "${VDE_ROOT_DIR}/templates"
check_dir "${VDE_ROOT_DIR}/tests"
check_dir "${VDE_ROOT_DIR}/githooks"
check_dir "${VDE_ROOT_DIR}/.github"
check_dir "${VDE_ROOT_DIR}/.gemini_security"

# 4. Continuous Security & Privacy Audit
if [[ -f "${VDE_ROOT_DIR}/bin/vde-security-audit.zsh" ]]; then
    zsh "${VDE_ROOT_DIR}/bin/vde-security-audit.zsh" || errors=$((errors + 1))
fi

# 5. Final Verdict [REWRITTEN]
if [[ $errors -gt 0 ]] || [[ $warnings -gt 0 ]]; then
    echo -e "\n${RED}[UAP-FAILURE]${NC} $errors violations and $warnings warnings detected."
    echo -e "${YELLOW}[MANDATE 14 ACTIVE]${NC} Agent must halt current phase and generate a remediation plan."
    exit 1
else
    [[ $quiet -eq 0 ]] && echo -e "\n${GREEN}[UAP-SUCCESS]${NC} All core mandates satisfied. Agent is cleared for action."
    # Support wrapping commands for Mandatory Enforcer Supervision (Mandate 3)
    # Only execute if the script is NOT being sourced (detecting via ZSH_EVAL_CONTEXT)
    if [[ $# -gt 0 && "${ZSH_EVAL_CONTEXT}" != *"toplevel"* ]]; then
        # If the only argument is --quiet, don't try to exec it
        if [[ "$1" != "--quiet" ]]; then
            [[ $quiet -eq 0 ]] && echo -e "${GREEN}[UAP-EXEC]${NC} Executing supervised command: $@"
            exec "$@"
        fi
    fi
    exit 0
fi
