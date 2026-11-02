# VDE ARCHITECTURAL RECORD
# @armor (Student Guidance)
Feature: Next Steps Guidance for Students and New Hires
  As a new student or hire using VDE
  I want clear guidance on what to do next after each command
  So I can efficiently navigate the VDE workflow

  Background: The Tetrad is Active
    Given the 4 Pillars (Zsh, Git, Docker, SSH) have passed their individual proofs
    And the Hub is synchronized to version 1.5.3
    And I execute "bin/vde uninstall vde-dynamic-vm --skip-confirm"
    And I execute "rm -rf .locks/global-config.lock"

  Scenario: After init, student sees guidance to create first VM
    When I execute "bin/vde init"
    Then the output should contain "VDE Initialization Complete!"
    And the output should contain "Next:"
    And the output should contain "vde create"
    And the output should contain "vde list"

  Scenario: After create, student sees guidance to start VM
    Given I have a valid VM definition for "python" in the Beskar Registry
    When I execute "bin/vde create python"
    Then the Docker image "vde-python" should exist on the Hub
    And the output should contain "Next:"
    And the output should contain "vde start python"
    And the output should contain "vde list"

  Scenario: After start, student sees guidance to enter VM
    Given I have a valid VM definition for "python" in the Beskar Registry
    And I execute "bin/vde create python"
    When I execute "bin/vde start python"
    Then a container named "vde-python" should be running
    And the output should contain "Next:"
    And the output should contain "vde enter python"
    And the output should contain "vde list"

  Scenario: After stop, student sees guidance to restart VM
    Given I have a valid VM definition for "python" in the Beskar Registry
    And I execute "bin/vde create python"
    And I execute "bin/vde start python"
    When I execute "bin/vde stop python"
    Then the container "vde-python" should not be running
    And the output should contain "Next:"
    And the output should contain "vde start python"
    And the output should contain "vde list"

  Scenario: After rm, student sees guidance to recreate VM
    Given I have a valid VM definition for "python" in the Beskar Registry
    And I execute "bin/vde create python"
    And I execute "bin/vde start python"
    And I execute "bin/vde stop python"
    When I execute "bin/vde rm python"
    Then the container "vde-python" should not exist
    And the output should contain "Next:"
    And the output should contain "vde create python"
    And the output should contain "vde list"

  Scenario: After restart, student sees guidance to enter VM
    Given I have a valid VM definition for "python" in the Beskar Registry
    And I execute "bin/vde create python"
    And I execute "bin/vde start python"
    When I execute "bin/vde restart python"
    Then the container "vde-python" should be running
    And the output should contain "Next:"
    And the output should contain "vde enter python"
    And the output should contain "vde list"

  Scenario: After rebuild, student sees guidance to start VM
    Given I have a valid VM definition for "python" in the Beskar Registry
    And I execute "bin/vde create python"
    When I execute "bin/vde rebuild python"
    Then the Docker image "vde-python" should exist on the Hub
    And the output should contain "Next:"
    And the output should contain "vde start python"
    And the output should contain "vde list"

  Scenario: vde list is always the final suggestion
    Given I have a valid VM definition for "python" in the Beskar Registry
    And I execute "bin/vde create python"
    When I execute "bin/vde start python"
    Then the output should contain "vde list"
    When I execute "bin/vde stop python"
    Then the output should contain "vde list"
