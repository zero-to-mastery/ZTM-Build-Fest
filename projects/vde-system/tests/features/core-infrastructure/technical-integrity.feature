# VDE ARCHITECTURAL RECORD
# @forge (Governance Sentinel)
Feature: VDE Technical Integrity Gate (The Armor)
  As a student or developer using the VDE
  I require a purely technical verification of my environment
  So that I can ignite the Armor without any AI-governance dependencies

  Scenario: Pillar I - ZSH Version Check
    Given the environment is being initialized
    When I execute "bin/vde-check-tetrad.zsh"
    Then the output should contain "[SUCCESS] Technical Integrity Verified"
    And the return code should be 0

  Scenario: Tetrad Pillar Presence
    Given the Unyielding Tetrad is installed
    When I check for command "git"
    And I check for command "docker"
    And I check for command "ssh"
    Then the return code should be 0

  Scenario: Environment Integrity - Required Directories
    Given the VDE root directory is active
    Then the directory "data" should exist
    And the directory ".cache" should exist
    And the directory "lib" should exist
    And the directory "scripts" should exist
