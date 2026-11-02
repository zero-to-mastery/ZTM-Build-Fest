# VDE ARCHITECTURAL RECORD
# @forge (Governance Sentinel)
@core-infrastructure @usp-validation @system-spine
Feature: Universal Script Parity (USP) Validation
  The VDE system enforces Universal Script Parity (USP) to ensure that every VM
  is hydrated through a standardized, hardened, and deterministic process.

  @usp @critical-path @usp-hardening @user-guide-installation
  Scenario: Verify all registered VMs have compliant setup scripts
    Given the VDE registry is loaded
    Then every VM must have a setup script in scripts/setup/
    And every script must have 'set -e' for deterministic error handling
    And every script must have 'apt-get clean' to minimize image size
    And every script must have 'rm -rf /var/lib/apt/lists/*' to purge ghosts
    And every script must have 'export DEBIAN_FRONTEND=noninteractive' to prevent prompts
    And every script must follow the 'Forged in Beskar' standardized header ritual

  @usp @security
  Scenario: Prevent Ghost Scripts in Setup Directory
    Given the VDE registry is loaded
    Then every script in "scripts/setup/" must be associated with a registered VM

  @usp @ritual @alias-resolution
  Scenario: Distill Aliases to Primary Hydration Rituals
    Given the VDE registry is loaded
    Then every registered alias must resolve to its primary hydration ritual
    And the resolution must point to a physical script on the Hub
