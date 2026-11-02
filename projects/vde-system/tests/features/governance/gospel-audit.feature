# Sovereign Gospel Integrity
# @forge (Governance Sentinel)
Feature: Sovereign Gospel Integrity
  As an Alor of the VDE
  I require empirical proof that the Gospel is synchronized with the physical implementation
  So that the Sovereign Artifact Set remains the absolute source of truth

  Scenario: Audit of the Sovereign Artifact Set (Existence)
    Given the Hub is active
    When I execute "bin/vde-gospel-audit.zsh"
    Then the output should contain "Auditing Sovereign Artifact Set"
    And the return code should be 0

  Scenario: Detection of Version Drift
    Given I have an intentional version mismatch in "data/vm-types.json"
    When I execute "bin/vde-gospel-audit.zsh"
    Then the output should contain "[CRITICAL FAILURE] Version drift detected"
    And the return code should be 13

  Scenario: Detection of Undocumented Scripts
    Given I create a temporary script "bin/vde-ghost-unseen.zsh"
    When I execute "bin/vde-gospel-audit.zsh"
    Then the output should contain "[CRITICAL FAILURE] Undocumented scripts detected"
    And the return code should be 1


