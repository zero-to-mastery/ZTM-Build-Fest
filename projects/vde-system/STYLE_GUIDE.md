# STYLE GUIDE
<!-- @shared-law (Forge Component) -->
Coding standards and style guidelines for the VDE (Virtual Development Environment) project.

## Table of Contents
1. [Shell Scripting Standards](#shell-scripting-standards)
2. [Testing Standards](#testing-standards)
3. [YAML Standards](#yaml-standards)
4. [Makefile Standards](#makefile-standards)
5. [Documentation Standards](#documentation-standards)

## Shell Scripting Standards

### Language
- **All shell scripts must use zsh** (`#!/usr/bin/env zsh`)
- Zsh version: 5.0 or later required
- **FORBIDDEN**: `/bin/sh` and `/usr/bin/env sh` are not allowed in this project
  - Using sh-compatible shebangs will result in immediate build failure
  - This project is zsh-only; contributions not following the ZSH-ONLY mandate will be rejected
- Do not use any non-ZSH shells for new scripts

### Project-Wide Shell Requirement
**Zsh is the official and only shell of this project.**
- All scripts must begin with `#!/usr/bin/env zsh` or `#!/bin/zsh`
- ShellCheck configuration must target zsh (SC5001)
- Any contribution using sh-compatible shebangs will be rejected

### File Structure
```zsh
#!/usr/bin/env zsh
# Brief description of what the script does
# Additional details if needed

# Source dependencies
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/library-name"

# Configuration
readonly CONFIG_VAR="value"
ANOTHER_VAR="${OPTIONAL_VAR:-default}"

# Main logic
main() {
    # Function body
}

main "$@"
```

### Indentation and Formatting
- **Indentation**: 2 spaces (no tabs)
- **Line length**: Maximum 120 characters (soft limit)
- **Trailing whitespace**: Never include trailing whitespace
- **Final newline**: Every file must end with a newline
- **Use `print -P`** for formatted output with colors

### Naming Conventions

#### Variables
- **Constants**: `UPPER_CASE_WITH_UNDERSCORES`
- **Local variables**: `lower_case_with_underscores`
- **Environment variables**: `UPPER_CASE_WITH_UNDERSCORES`
- **Private variables**: Prefix with `_` (e.g., `_private_var`)

```zsh
readonly MAX_RETRIES=3
local current_vm=""
local _internal_state
```

#### Functions
- **Private functions**: Start with `_` (e.g., `_helper_function`)
- **Public functions**: `lower_case_with_underscores`
- **Use descriptive names** that describe what the function does

```zsh
_get_vm_info() {
    # Private helper function
}

list_all_vms() {
    # Public function
}
```

#### Arrays
- **Use parentheses for array assignment**
- **Quote array elements** to prevent word splitting

```zsh
VM_NAMES=("python" "rust" "go")
for vm in "${VM_NAMES[@]}"; do
    echo "Processing: $vm"
done
```

### Quoting
- **Always quote variables**: `"$VAR"` not `$VAR`
- **Exception**: Use `$@` (not quoted) when you want word splitting
- **Quote string comparisons**: `[[ "$var" == "value" ]]`

### Conditionals
- **Use `[[`** for string comparisons (not `[` or `((`)
- **Use `-a`** for and, `-o`** for or

```zsh
if [[ "$vm_type" == "lang" ]] && [[ -n "$vm_name" ]]; then
    echo "Valid language VM"
fi

# Check for empty string
if [[ -z "$var" ]]; then
    echo "Variable is empty"
fi
```

### Loops
```zsh
# C-style for loop (preferred over range)
for ((i = 1; i <= 10; i++)); do
    echo "Iteration $i"
done

# Array iteration
for vm in "${VM_ARRAY[@]}"; do
    echo "Processing: $vm"
done

# While loop
while [[ $count -lt $max ]]; do
    ((count++))
done
```

### Functions
- **Always use `local`** for function-scoped variables
- **Return exit codes**: 0 for success, non-zero for failure
- **Print to stdout for data, stderr for errors**

```zsh
process_vm() {
    local vm_name="$1"
    local result

    # Process the VM
    result=$(get_vm_info "$vm_name") || return 1

    echo "$result"
    return 0
}
```

### Error Handling
- **Use `|| return 1`** for early return on error
- **Use `set -e`** cautiously in scripts (see below)
- **Provide meaningful error messages**

```zsh
# Option 1: Early return
validate_vm() {
    [[ -n "$1" ]] || { echo "Error: VM name required" >&2; return 1; }
}

# Option 2: set -e with careful error handling
#!/usr/bin/env zsh
set -e  # Exit on error
# But be careful - this can cause issues in some cases

# Option 3: Explicit error checking (recommended)
run_command() {
    local output
    output=$(some_command 2>&1) || {
        echo "Command failed: some_command" >&2
        echo "Output: $output" >&2
        return 1
    }
}
```

### Special Zsh Features

#### Parameter Expansion
```zsh
# Default value
"${VAR:-default}"      # Use default if VAR is unset or null
"${VAR:=default}"      # Assign default if VAR is unset or null

# String manipulation
"${VAR:u}"             # Uppercase
"${VAR:l}"             # Lowercase
"${VAR:s/pattern/repl/}"  # Substitution

# Array operations
"${ARRAY[@]}"           # All elements
"${ARRAY[1]}"           # Second element (0-indexed)
"${#ARRAY[@]}"          # Array length
```

#### Glob Qualifiers
```zsh
# Null glob (no error if no matches)
setopt local_options null_glob
for file in *.sh(N); do
    echo "Found: $file"
done

# Case-insensitive glob
for file in *(#*.txt); do
    echo "Found: $file"
done
```

### Comments
- **Use `#` for comments**
- **Place comments above the code** they describe
- **Explain why**, not what (for complex logic)
- **Use section headers** for long files

```zsh
# =============================================================================
# Section: VM Discovery
# =============================================================================

# Check if VM exists by name
# Returns 0 if found, 1 otherwise
vm_exists() {
    local vm_name="$1"
    # ...
}
```

### Colors and Formatting
```zsh
# Define color constants
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly NC='\033[0m'  # No Color

# Use with print -P for prompt expansion
print -P "${GREEN}Success!${NC}"
print -P "${YELLOW}Warning:${NC} Something might be wrong"
print -P "${RED}Error:${NC} Something failed"
```

### Shebang
Always use explicit shell paths:
- For zsh scripts: `#!/bin/zsh`
- Or: `#!/usr/bin/env zsh`

Not:
```zsh
#!/bin/sh   # Wrong - we use zsh features
```

Reference: See `.gemini/RULES/` directory for project conventions.

### File Organization
For larger scripts, organize with sections:
```zsh
#!/usr/bin/env zsh
# Description

# =============================================================================
# Configuration
# =============================================================================

readonly SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# =============================================================================
# Dependencies
# =============================================================================

source "$SCRIPT_DIR/lib/common"

# =============================================================================
# Helper Functions
# =============================================================================

_helper_func() {
    # ...
}

# =============================================================================
# Main Functions
# =============================================================================

main() {
    # ...
}

# =============================================================================
# Entry Point
# =============================================================================

main "$@"
```

## Testing Standards

The VDE project enforces a **100% Real Tests Mandate**. Every test must execute actual VDE functionality. No fake tests, no context flags, no tautological assertions.

### ⚠️ Prohibited Testing Patterns (FAKE TESTING)
The following patterns are strictly forbidden as they undermine testing confidence:

1. **Simulated State**: Any code claiming to "simulate" behavior instead of executing it.
2. **Context Flags**: Setting internal state flags (e.g., `context.vm_started = True`) instead of running real commands.
3. **Intent-Only Verification**: Asserting that a command *would* have been run, rather than verifying it *was* run and produced the expected outcome.
4. **Tautological Assertions**: Using `assert True` or patterns that cannot fail (e.g. `getattr(context, 'x', True)`).
5. **Silent Bypasses**: Using `pass` or empty steps in BDD `@then` scenarios.

### Required Testing Patterns
All tests must verify the **Actual System State**:

| Category | Required Practice | Example |
|----------|-------------------|---------|
| **Execution** | Execute REAL VDE/Docker commands | `subprocess.run(['vde', 'start', 'python'])` |
| **Verification** | Check ACTUAL container state | `docker ps -a --filter "name=vde-python"` |
| **Integrity** | Check REAL exit codes and stderr | `assert result.returncode == 0` |
| **Side Effects** | Verify REAL filesystem changes | `Path('/path/to/vde/conf').exists()` |

### Rule on Regression
IF a Fake Test violation is found, whether pre-existing or new, **IT MUST BE FIXED** before the change can be accepted. There is no "grandfathering" for legacy fake tests.

## YAML Standards

### General
- **Indentation**: 2 spaces
- **Quotes**: Prefer single quotes for strings
- **Line length**: Maximum 120 characters

### GitHub Actions Workflows
```yaml
# Optional document start marker (use if file contains multiple documents)
---
name: Workflow Name

on:
  push:
    branches: [main]

jobs:
  job-name:
    runs-on: ubuntu-latest
    steps:
      - name: Step name
        run: |
          echo "Multi-line command"
          echo "Another line"
```

## Makefile Standards

### General
- **Use TABS** for indentation (Makefile requirement)
- **Use `.PHONY`** for targets that don't produce files
- **Add comments** above targets

```makefile
# .PHONY declares non-file targets
.PHONY: help test clean

# Default target
help:
	@echo "Available targets:"
	@echo "  make test - Run tests"

# Test target
test:
	./bin/run-tests.sh
```

## Documentation Standards

### Markdown
- **Line length**: No hard limit (wrap where natural)
- **Headers**: Use ATX style (`# Header` not `Header\n======`)
- **Code blocks**: Specify language for syntax highlighting
- **Lists**: Use `-` for bulleted lists

### README Structure
1. Project title and brief description
2. Quick start
3. Prerequisites
4. Installation
5. Usage examples
6. Configuration
7. Contributing
8. License

## Code Review Guidelines

### What to Look For
1. **Syntax**: Does the code follow zsh best practices?
2. **Error handling**: Are errors handled gracefully?
3. **Variable quoting**: Are variables properly quoted?
4. **Comments**: Is complex logic explained?
5. **Testing**: Are there tests for new functionality?
6. **Documentation**: Is the code self-documenting or commented?

### Common Issues
- ❌ Unquoted variables: `echo $VAR`
- ✅ Quoted variables: `echo "$VAR"`

- ❌ Using `[` for tests: `[ "$var" == "value" ]`
- ✅ Using `[[` for tests: `[[ "$var" == "value" ]]`

- ❌ No error handling: `rm file`
- ✅ Error handling: `rm file || { echo "Failed"; return 1; }`

## Tools and Validation

### Syntax Checking
```zsh
# Check zsh script syntax
zsh -n script.sh

# Check all scripts
for script in bin/**/*.sh tests/**/*.sh; do
    zsh -n "$script" || echo "Syntax error in: $script"
done
```

### Formatting (Local Only)
```zsh
# Basic formatting (use with caution - may not handle all zsh features)
shfmt -w script.sh

# Check formatting
shfmt -d script.sh
```

## When in Doubt

1. **Follow existing patterns** in the codebase
2. **Ask for review** if unsure about style
3. **Prioritize readability** over cleverness
4. **Keep it simple** - zsh is powerful, but complex code is hard to maintain

## Resources

- [Zsh Reference Manual](https://zsh.sourceforge.io/Doc/Release/)
- [Zsh Loops](https://zsh.sourceforge.io/Guide/zshguide.html)
- [EditorConfig Specification](https://editorconfig.org/)
- [GitHub Actions Workflow Syntax](https://docs.github.com/en/actions/reference/workflow-syntax-for-github-actions)
