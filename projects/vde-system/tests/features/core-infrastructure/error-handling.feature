# VDE ARCHITECTURAL RECORD
# @forge (Governance Sentinel)
@core-infrastructure @error-handling @system-spine
Feature: Deterministic Error Engine
  As an Alor of the VDE
  I require precise error reporting and signal translation
  So that system failures are transparent and remediable

  @error @signals
  Scenario: SIGINT Interception Translation
    Given the VDE system is healthy
    When I simulate a user interruption (SIGINT) during "bin/vde start python"
    Then the output should contain "Operation Interrupted"
    And the output should contain "Received SIGINT (Ctrl+C)"

  @error @signals
  Scenario: SIGKILL Forceful Termination Translation
    Given the VDE system is healthy
    When I simulate a forceful termination (SIGKILL) during "bin/vde start python"
    Then the output should contain "Process Terminated"
    And the output should contain "indicates an Out-Of-Memory (OOM) condition or Docker daemon failure"

  @error @concurrency @locking
  Scenario: Lock Contention Ownership Transparency
    Given the VDE system is healthy
    And a background process holds a lock on "python"
    When I attempt to start "python" in the foreground
    Then the output should contain "Waiting for lock: python.lock"
    And the output should contain "Held by:"
    And the output should contain the PID of the background process
