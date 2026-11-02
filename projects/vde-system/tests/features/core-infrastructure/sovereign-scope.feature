# VDE BDD Feature: Sovereign Scope
# @armor (Sovereign Scope Hardening)
Feature: The Sovereign Scope - Absolute Scoping
  As an Alor of the VDE
  I require the Forge to anchor itself to the project root
  So that I can execute strikes from any location on the host system

  Scenario: Wanderer Strike - Executing from External Directory
    Given the VDE bin directory is in my PATH
    And I am currently in a directory outside of VDE_ROOT_DIR
    When I execute the wanderer command "vde help"
    Then the output should contain "Usage: vde <command> [arguments]"
    And the return code should be 0

  Scenario: Wanderer Discovery - Listing Spokes from External Directory
    Given the VDE bin directory is in my PATH
    And I am currently in a directory outside of VDE_ROOT_DIR
    When I execute the wanderer command "vde list --all"
    Then the command should succeed
    And the output should contain "python"
    And the output should contain "postgres"
