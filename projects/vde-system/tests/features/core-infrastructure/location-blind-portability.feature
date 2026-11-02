Feature: Location-Blind Portability
# @shared-law (Empirical Portability Proof)
  As a User of the VDE
  I require the system to correctly scope itself to its installation directory
  Regardless of my current working directory on the filesystem
  So that I can execute "vde" from anywhere with absolute integrity

  Background:
    Given the 4 Pillars (Zsh, Git, Docker, SSH) have passed their individual proofs

  Scenario: Invoking VDE CLI from an external directory
    Given I change the current working directory to "/tmp"
    When I execute the absolute path of "bin/vde" with "list --lang --name-only -a"
    Then the output should contain "vde-"
    And the return code should be 0

  Scenario: Sourcing VDE Constants from an external directory
    Given I change the current working directory to "/tmp"
    When I source the absolute path of "lib/vde-constants" in a new Zsh shell
    Then the variable "VDE_ROOT_DIR" should point to the VDE installation directory
    And the variable "VDE_ROOT_DIR" should not be "."
