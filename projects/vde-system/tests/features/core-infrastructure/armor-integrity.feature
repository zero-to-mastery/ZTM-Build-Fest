# Armor Structural Integrity
# @forge (Governance Sentinel)
Feature: Armor Structural Integrity
  As a student using the VDE
  I require empirical proof that the Armor can detect its own fractures
  So that I am never operating in a corrupted environment

  Scenario: Detection of Missing Core Artifacts
    Given the Hub is active
    And I temporarily move "data/vm-types.json" to "data/vm-types.json.hidden"
    When I execute "bin/vde-check-tetrad.zsh"
    Then the output should contain "[ERROR] Missing core artifact: data/vm-types.json"
    And the return code should be 1
    And I restore "data/vm-types.json.hidden" to "data/vm-types.json"

  Scenario: Detection and Healing of Armor Baseline Drift
    Given I have an intentional version mismatch in "data/vm-types.json"
    When I execute "bin/vde-check-tetrad.zsh"
    Then the output should contain "[ERROR] Baseline Drift"
    And the output should contain "[SUCCESS] Baseline synchronized"
    And the return code should be 0
    And I restore "data/vm-types.json" to its original state

  Scenario: Proof of Relative Pathing Compliance
    Given the Hub is active
    When I execute "bin/vde-check-tetrad.zsh"
    Then the output should NOT contain "SLASH_Users_SLASH"
    And the output should NOT contain "SLASH_home_SLASH"
    And the return code should be 0


  Scenario: Proof of AI-Blind Autonomy (Forge Blockade)
    Given the Hub is active
    And I temporarily move ".gemini" to ".gemini.blocked"
    When I execute "bin/vde-check-tetrad.zsh"
    Then the output should contain "[SUCCESS] Technical Integrity Verified"
    And the return code should be 0
    And I restore ".gemini.blocked" to ".gemini"

