# VDE ARCHITECTURAL RECORD
# @forge (Governance Sentinel)
@core-infrastructure @locking @recursion
Feature: Anti-Recursion and Hardened Locking
  As an Alor of the VDE
  I require empirical proof that the infinite recursion and locking fractures are remediated
  So that the Forge remains responsive during high contention or process crashes

  Scenario: Empirical Proof: Stale Lock Buster (Crashed Process)
    Given a stale lock exists on "global-config.lock" with a dead PID and 15s age
    When I execute "bin/vde rebuild-cache"
    Then the command should succeed
    And the stale lock should be automatically purged
    And the return code should be 0

  Scenario: Empirical Proof: Stale Ticket Buster (Queued Process)
    Given a stale ticket exists in the lock queue from a dead PID
    When I execute "bin/vde rebuild-cache"
    Then the command should succeed
    And the stale ticket should be removed from the queue
    And the return code should be 0

  Scenario: Empirical Proof: Process Explosion Protection (Recursion Break)
    When I simulate lock contention on "global-config.lock"
    Then the number of child "vde-poll" processes should not exceed the linear growth limit
    And the system load must remain stable during polling
    And vde-poll must exit cleanly without sourcing lib/vm-common recursively
