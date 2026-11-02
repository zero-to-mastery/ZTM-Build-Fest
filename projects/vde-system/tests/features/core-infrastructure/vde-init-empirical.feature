# VDE ARCHITECTURAL RECORD
# @forge (Governance Sentinel)
@vde-init @core-infrastructure
Feature: vde init (Sovereign Baseline)
  As an Alor of the VDE
  I require a deterministic initialization ritual
  So that the Hub's infrastructure is forged correctly

  Scenario: Initializing the VDE Hub
    Given the Hub is uninitialized
    When I execute "bin/vde init"
    Then the mandatory directories should exist:
      | directory |
      | .cache    |
      | data      |
      | projects  |
    And the SSH identity "vde_student" should exist in the SSH directory
    And the Docker network "vde-net" should be active
    And the exit code should be 0
