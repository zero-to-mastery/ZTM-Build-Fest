# VDE ARCHITECTURAL RECORD
# @forge (Governance Sentinel)
@core-infrastructure @ssh @spoke-to-spoke
Feature: Spoke-to-Spoke SSH Connectivity
  As an Alor of the VDE
  I require empirical proof of internal SSH connectivity between Spokes
  So that tech stacks can utilize secure transversal communication autonomously

  Background: Core Spokes are Active
    Given the VDE system is healthy
    And "python" is running
    And "rust" is running

  Scenario: Empirical Proof: Internal SSH Handshake
    When I execute "ssh -o BatchMode=yes -o StrictHostKeyChecking=no vde-python echo 'SSH_SUCCESS'" inside "rust"
    Then the exit code should be 0
    And the output should contain "SSH_SUCCESS"

  Scenario: Integrity Audit: Internal SSH Configuration
    When I execute "cat /home/devuser/.ssh/config" inside "rust"
    Then the output should contain "Host vde-python"
    And the output should contain "HostName vde-python"
    And the output should contain "IdentityFile ~/.ssh/vde/vde_student"
