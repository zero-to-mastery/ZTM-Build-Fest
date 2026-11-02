# VDE ARCHITECTURAL RECORD
# @forge (Governance Sentinel)
@advanced-orchestration @dns @phase31
Feature: Phase 31 - Spoke-to-Spoke DNS & Sovereign Bridge
  As an Alor of the VDE
  I require empirical proof of the Phase 31 DNS discovery and Hub-to-Spoke bridge
  So that multi-VM tech stacks can communicate without hardcoded host paths or IPs

  Background: Core Services are Active
    Given the VDE system is healthy
    And the Hub is synchronized to version 1.5.6
    And "python" is running
    And "postgres" is running

  Scenario: Empirical Proof: Spoke-to-Spoke DNS Discovery (Canonical Name)
    When I execute "ping -c 2 vde-postgres" inside "python"
    Then the exit code should be 0
    And the output should contain "64 bytes from vde-postgres"

  Scenario: Empirical Proof: Spoke-to-Spoke DNS Discovery (Short Alias)
    When I execute "ping -c 2 postgres" inside "python"
    Then the exit code should be 0
    And the output should contain "64 bytes from vde-postgres"

  Scenario: Empirical Proof: Hub-to-Spoke Sovereign Bridge (vde-host alias)
    When I execute "ping -c 2 vde-host" inside "python"
    Then the exit code should be 0
    And the output should contain "64 bytes from"

  Scenario: Empirical Proof: Service Bridge Connectivity (TCP Handshake)
    When I execute "nc -zv postgres 5432" inside "python"
    Then the exit code should be 0
    And the output should contain "succeeded"

  Scenario: Portability Audit: Relative DNS Configuration
    Given I have a valid VM definition for "python" in the Beskar Registry
    Then the Docker Compose manifest for "python" must not contain absolute host paths
    And the DNS aliases must be generated from relative metadata
