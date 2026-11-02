# VDE ARCHITECTURAL RECORD
# @forge (Governance Sentinel)
@governance @healing @phase32
Feature: Phase 32 - Forge Intelligence & Auto-Remediation
  As an Alor of the VDE
  I require empirical proof of the Phase 32 self-healing and auto-remediation features
  So that the Gospel and the Forge remain synchronized without manual intervention

  Background: The Forge is Initialized
    Given the VDE system is healthy
    And the Hub is synchronized to version 1.5.6

  Scenario: Empirical Proof: Registry Self-Healing (CONF -> JSON)
    Given I corrupt the Beskar Registry "data/vm-types.json" with invalid content
    When I execute "bin/vde heal"
    Then the registry "data/vm-types.json" should be restored from the Authority
    And the schema validation must pass for "data/vm-types.json"

  Scenario: Empirical Proof: Gospel Version Synchronization
    Given I intentionally drift the version in "docs/changelogs/current.md" to "0.0.1"
    When I execute "bin/vde heal"
    Then the file "docs/changelogs/current.md" should contain the Sovereign Baseline version "1.5.6"
    And the Gospel Audit must report "synchronized"

  Scenario: Empirical Proof: Path Leak Remediation (Blockade Simulation)
    Given I inject an absolute path "/[U]sers/dderyldowney/VDE/lib" into a temporary script
    When I execute "bin/vde-enforce-uap.zsh"
    Then the UAP Enforcer should detect the blockade
    And the return code should be 1
    And the output should contain "[CRITICAL] Absolute Path Leaks Detected"
