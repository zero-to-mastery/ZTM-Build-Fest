# VDE ARCHITECTURAL RECORD
# @forge (Governance Sentinel)
@core-infrastructure @gateway @system-spine
Feature: The Four Pillars Gateway
  As an Alor of the VDE
  I require empirical proof that the host environment is prepared
  So that the Sovereign Forge can be ignited without failure

  Background: Hub Readiness
    Given the Hub is active
    And the Hub is synchronized to version 1.5.6

  @pillar-1 @docker
  Scenario: Pillar I - The World-Forge (Docker Readiness)
    Given the Docker daemon is responsive
    When I execute "docker version"
    Then the output should contain "Client:"
    And the return code should be 0

  @pillar-2 @git
  Scenario: Pillar II - The Chronicler (Git Readiness)
    When I execute "git --version"
    Then the output should contain "git version"
    And the return code should be 0

  @pillar-3 @zsh
  Scenario: Pillar III - The Voice of the Tribe (Zsh Readiness)
    When I execute "zsh --version"
    Then the output should contain "zsh 5."
    And the return code should be 0

  @pillar-4 @ssh
  Scenario: Pillar IV - The Transversal Bridge (SSH Readiness)
    When I execute "ssh -V"
    Then the output should contain "OpenSSH"
    And the return code should be 0

  @gateway-init
  Scenario: Gateway Verification - Full Initialization
    Given the 4 Pillars (Zsh, Git, Docker, SSH) have passed their individual proofs
    When I execute "bin/vde init"
    Then the output should contain "VDE Initialization Complete!"
    And the return code should be 0
    And the directory ".cache" should exist
    And the directory "projects" should exist
    And the file "docs/operations/installation.md" should exist
    And the file "docs/operations/installation.md" should contain "git clone -b stable https://github.com/dderyldowney/vde-system.git"
