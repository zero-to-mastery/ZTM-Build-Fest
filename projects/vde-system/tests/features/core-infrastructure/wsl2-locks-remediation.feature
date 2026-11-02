# VDE ARCHITECTURAL RECORD
# @forge (Governance Sentinel)
@core-infrastructure @locking @wsl2
Feature: WSL2 Stale Locks and Tickets Remediation
  As an Alor of the VDE
  I require WSL2-specific lock and ticket handling to be hardened
  So that abrupt process termination does not leave stale locks or tickets

  Background:
    Given the VDE system is healthy
    And the registry is reconciled

  @wsl2 @stale-locks
  Scenario: WSL2 Abrupt Termination Lock Cleanup
    Given a lock is held by a process that terminates abruptly
    When I execute "bin/vde rebuild-cache"
    Then the stale lock should be automatically purged within 5 seconds
    And the return code should be 0

  @wsl2 @stale-tickets
  Scenario: WSL2 Queue Directory Cleanup on Tactical Sweep
    Given multiple stale tickets exist in the lock queue from dead PIDs
    When I execute "bin/vde-tactical-sweep.zsh"
    Then all queue directories should be cleaned
    And the return code should be 0

  @wsl2 @preflight-check
  Scenario: Pre-flight Lock Health Check
    Given stale locks and tickets exist from previous sessions
    When I execute "bin/vde status"
    Then lock system health should be verified
    And stale artifacts should be cleaned automatically
    And the command should succeed

  @wsl2 @graceful-shutdown
  Scenario: WSL2 Graceful Shutdown Handler
    Given WSL2 environment is detected
    When a VDE process receives termination signal
    Then the zshexit hook should clean all owned tickets
    And lock directories owned by the process should be released

  @wsl2 @edge-cases
  Scenario: WSL2 Simultaneous Process Termination
    Given the VDE system is healthy
    And the registry is reconciled
    Given 5 VDE processes are running concurrently on WSL2
    When multiple VDE processes terminate abruptly
    When I execute "bin/vde rebuild-cache"
    Then all stale locks and tickets should be purged
    And the return code should be 0