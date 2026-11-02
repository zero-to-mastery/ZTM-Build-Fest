# VDE ARCHITECTURAL RECORD
# @forge (Governance Sentinel)
@student-workflow
Feature: Student Daily Usage
  As a new student user studying computer programming
  I want a simple, reliable daily workflow for my isolated development environments
  So that I can focus on learning to code instead of managing infrastructure

  Background: The Environment is Ready
    Given the 4 Pillars (Zsh, Git, Docker, SSH) have passed their individual proofs
    And the Hub is synchronized to version 1.5.6

  Scenario: A Typical Study Session (Start, Code, Stop)
    Given I have a valid VM definition for "python" in the Beskar Registry
    When I execute "bin/vde start python"
    Then a container named "vde-python" should be running
    And the SSH bridge to "python" should be established
    When I execute "bin/vde enter python 'python3 --version'"
    Then the command should succeed
    And the output should contain "Python 3."
    When I execute "bin/vde stop python"
    Then the container "vde-python" should not be running

  Scenario: Exploring a New Language (Create, Start, Enter, Remove)
    Given I have a valid VM definition for "go" in the Beskar Registry
    When I execute "bin/vde create go"
    Then the Docker image "vde-go" should exist on the Hub
    When I execute "bin/vde start go"
    Then a container named "vde-go" should be running
    When I execute "bin/vde enter go 'go version'"
    Then the command should succeed
    And the output should contain "go version"
    When I execute "bin/vde stop go"
    Then the container "vde-go" should not be running
    When I execute "bin/vde rm go"
    Then the container "vde-go" should not exist
