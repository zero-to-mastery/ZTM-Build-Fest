# Function Trace Diagnostic Command
# @forge (Forge Diagnostic Tooling)
Feature: VDE Function Trace Diagnostic Command
  As a VDE support technician
  I need to trace the full function call chain for any vde command
  So I can diagnose user issues without executing side effects

  # =========================================================================
  # SHALLOW TRACES - Simple commands with minimal function calls
  # =========================================================================

  @forge
  Scenario: Shallow trace for list command
    Given the Hub is active
    When I execute "bin/vde function-trace list"
    Then the output should contain "[dispatch: vde list]"
    And the output should contain "Function: vde_run()"
    And the output should contain "SUMMARY"
    And the return code should be 0

  @forge
  Scenario: Shallow trace for enter command shows SSH executor
    Given the Hub is active
    When I execute "bin/vde function-trace enter python ls"
    Then the output should contain "[EXECUTOR] ssh"
    And the output should contain "-p 2217"
    And the output should contain "devuser@127.0.0.1"
    And the container "vde-python" should not be running

  @forge
  Scenario: Shallow trace for stop command on non-running VM
    Given the Hub is active
    When I execute "bin/vde function-trace stop python"
    Then the output should contain "[dispatch: vde stop]"
    And the output should contain "resolve_vm_name()"
    And the output should contain "Params: python"

  # =========================================================================
  # DEEP TRACES - Commands with many function calls
  # =========================================================================

  @forge
  Scenario: Deep trace for start command shows full resolution chain
    Given the Hub is active
    When I execute "bin/vde function-trace start python"
    Then the output should contain "Function:"
    And the output should contain "File: $VDE_ROOT_DIR"
    And the output should contain "resolve_vm_name()"
    And the output should contain "is_vm_running()"
    And the output should contain "get_vm_compose_file()"
    And the output should contain "image_exists()"
    And the return code should be 0

  @forge
  Scenario: Deep trace shows library boundary transitions
    Given the Hub is active
    When I execute "bin/vde function-trace start python"
    Then the output should contain "lib/vm-common"
    And the output should contain "lib/vde-docker"
    And the output should contain "bin/vde"

  @forge
  Scenario: Deep trace for rebuild shows command assembly
    Given the Hub is active
    When I execute "bin/vde function-trace rebuild python"
    Then the output should contain "[debug] build_cmd=docker compose"
    And the output should contain "[EXECUTOR] docker compose"
    And the output should contain "build"

  # =========================================================================
  # COMMAND BUILDING - Step-by-step command assembly
  # =========================================================================

  @forge
  Scenario: Trace shows step-by-step command building for start
    Given the Hub is active
    When I execute "bin/vde function-trace start python"
    Then the output should contain "[debug] compose_up_cmd=docker compose"
    And the output should contain "compose_up_cmd=docker compose -f"
    And the output should contain "up -d"

  @forge
  Scenario: Trace shows --no-cache flag passed through rebuild
    Given the Hub is active
    When I execute "bin/vde function-trace rebuild rust --no-cache"
    Then the output should contain "--no-cache"
    And the output should contain "[EXECUTOR]"

  # =========================================================================
  # EXECUTOR BOUNDARY - No side effects executed
  # =========================================================================

  @forge
  Scenario: Trace stops at executor without starting container
    Given the Hub is active
    When I execute "bin/vde function-trace start python"
    Then the output should contain "[EXECUTOR]"
    And the output should contain "docker compose"
    And the container "vde-python" should not be running

  @forge
  Scenario: Trace shows vde_run before executor boundary
    Given the Hub is active
    When I execute "bin/vde function-trace start python"
    Then the output should contain "vde_run()"

  @forge
  Scenario: Trace includes dispatch entry point
    Given the Hub is active
    When I execute "bin/vde function-trace start python"
    Then the output should contain "dispatch: vde start"

  # =========================================================================
  # SUMMARY SECTION - Key events and final command
  # =========================================================================

  @forge
  Scenario: Summary shows resolved VM name
    Given the Hub is active
    When I execute "bin/vde function-trace start python"
    Then the output should contain "SUMMARY"
    And the output should contain "Command: vde start"
    And the output should contain "Resolved 'python'"

  @forge
  Scenario: Summary shows final command that would execute
    Given the Hub is active
    When I execute "bin/vde function-trace start python"
    Then the output should contain "Final Command:"
    And the output should contain "docker compose"
    And the output should contain "up -d"

  @forge
  Scenario: Summary shows suppressed calls count
    Given the Hub is active
    When I execute "bin/vde function-trace start python"
    Then the output should contain "suppressed"

  # =========================================================================
  # PARAMETER CAPTURE - Arguments passed to functions
  # =========================================================================

  @forge
  Scenario: Trace captures argument values passed to functions
    Given the Hub is active
    When I execute "bin/vde function-trace start python"
    Then the output should contain "Params: vde-python"

  @forge
  Scenario: Trace shows disk space threshold parameter
    Given the Hub is active
    When I execute "bin/vde function-trace start python"
    Then the output should contain "vde_ensure_disk_space()"
    And the output should contain "Params: 95"

  @forge
  Scenario: Trace shows lock file path for rebuild
    Given the Hub is active
    When I execute "bin/vde function-trace rebuild python"
    Then the output should contain "claim_lock()"
    And the output should contain ".locks"

  # =========================================================================
  # DEBUGGING SCENARIOS - Real-world troubleshooting
  # =========================================================================

  @forge
  Scenario: Debug alias resolution for short name
    Given the Hub is active
    When I execute "bin/vde function-trace start py"
    Then the output should contain "resolve_vm_name()"
    And the output should contain "Params: py"

  @forge
  Scenario: Debug shows image check before start
    Given the Hub is active
    When I execute "bin/vde function-trace start python"
    Then the output should contain "image_exists()"
    And the output should contain "Image check"

  @forge
  Scenario: Debug shows VM running check
    Given the Hub is active
    When I execute "bin/vde function-trace start python"
    Then the output should contain "is_vm_running()"
    And the output should contain "VM running check"
