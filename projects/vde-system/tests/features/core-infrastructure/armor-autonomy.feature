# Armor Independent Autonomy
# @forge (Governance Sentinel)
Feature: Armor Independent Autonomy
  As a student using the VDE
  I require empirical proof that the Armor is self-correcting and self-healing
  So that it remains 100% functional without knowledge of the Forge

  Scenario: Armor Independent Self-Correction (Version Drift)
    Given the Hub is active
    And I temporarily move ".gemini" to ".gemini.blocked"
    And I have an intentional version mismatch in "data/vm-types.json"
    When I execute "bin/vde-check-tetrad.zsh"
    Then the output should contain "Attempting Armor Self-Correction"
    And the output should contain "[SUCCESS] The Armor is healed and autonomous"
    And the return code should be 0
    And I restore ".gemini.blocked" to ".gemini"

  Scenario: Proof of AI-Blind Autonomy (Forge Blockade Simulation)
    Given the Hub is active
    And I create a temporary directory ".forge-mock"
    And I temporarily move ".forge-mock" to ".forge-mock.blocked"
    And I temporarily move ".cache" to ".cache.hidden"
    When I execute "bin/vde-armor-heal.zsh"
    Then the directory ".cache" should exist
    And the output should contain "[HEALED] Restored directory: .cache"
    And the return code should be 0
    And I remove ".forge-mock.blocked"
    And I remove ".cache.hidden"

