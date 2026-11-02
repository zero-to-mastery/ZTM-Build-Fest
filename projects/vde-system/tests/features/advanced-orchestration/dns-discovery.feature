# VDE ARCHITECTURAL RECORD
# @forge (Governance Sentinel)
@advanced-orchestration @dns
Feature: Spoke-to-Spoke DNS Discovery
  As an Alor of the VDE
  I require Spokes to discover each other by canonical name
  So that multi-VM tech stacks can communicate without hardcoded IPs

  Background: Core Services are Active
    Given the VDE system is healthy
    And the Hub is synchronized to version 1.5.6
    And "python" is running
    And "postgres" is running

Scenario: ICMP Heartbeat Discovery (Prefixed Name)
  When I execute "ping -c 2 vde-postgres" inside "python" to verify DNS
  Then the exit code should be 0

Scenario: ICMP Heartbeat Discovery (Short Alias)
  When I execute "ping -c 2 postgres" inside "python" to verify DNS
  Then the exit code should be 0

Scenario: Canonical Name Resolution (Dual Verification)
  When I execute "nslookup vde-postgres" inside "python" to verify DNS
  Then the exit code should be 0
  When I execute "nslookup postgres" inside "python" to verify DNS
  Then the exit code should be 0

  Scenario: Service Bridge Connectivity (Short Alias TCP)
    When I execute "nc -zv postgres 5432" inside "python" to verify DNS
    Then the exit code should be 0

  Scenario: Sovereign Bridge Resolution (Hub-to-Spoke)
  When I execute "ping -c 2 vde-host" inside "python" to verify DNS
  Then the exit code should be 0
  When I execute "ping -c 2 host" inside "python" to verify DNS
  Then the exit code should be 0
