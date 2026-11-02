# VDE ARCHITECTURAL RECORD
# @forge (Governance Sentinel)
Feature: The Proof of Life - The Contract
  As an Alor of the VDE
  I require empirical proof of the absolute lifecycle
  So that the journey from a fresh clone to a fully hydrated ecosystem is certified

  Background: The Tetrad is Active
    Given the 4 Pillars (Zsh, Git, Docker, SSH) have passed their individual proofs
    And the Hub is synchronized to version 1.5.6
    # Ensure no lingering test VMs from failed runs
    And I execute "bin/vde uninstall vde-dynamic-vm --skip-confirm"
    And I execute "rm -rf .locks/global-config.lock"

  Scenario: Lifecycle Step 1 - The Initialization Ritual (vde init)
    When I execute "bin/vde init"
    Then the output should contain "VDE Initialization"
    And the command should succeed
    And the directory ".cache" should exist
    And the directory "projects" should exist
    And the directory "data" should exist
    And the file "docs/operations/installation.md" should exist
    And the file "docs/operations/installation.md" should contain "git clone -b stable https://github.com/dderyldowney/vde-system.git"
    And the VDE_SSH_DIR should contain the "vde_student" identity
    And the Docker network "vde-net" should exist

  Scenario: Lifecycle Step 2 - Spoke Creation and Ignition (create & start)
    Given I have a valid VM definition for "python" in the Beskar Registry
    When I execute "bin/vde create python"
    Then the Docker image "vde-python" should exist on the Hub
    And the return code should be 0
    When I execute "bin/vde start python"
    Then a container named "vde-python" should be running
    And the SSH bridge to "python" should be established
    And the return code should be 0

  Scenario: Lifecycle Step 3 - Spoke Interaction and Maintenance (enter & rebuild)
    Given "vde-python" is currently running
    When I execute "bin/vde enter python 'echo \"The Contract is Signed\"'"
    Then the output should contain "The Contract is Signed"
    And the command should be executed as the "vde_student" identity
    And the return code should be 0
    When I execute "bin/vde rebuild python"
    Then the command should succeed
    And the Docker image "vde-python" should exist on the Hub
    And the container "vde-python" should be running
    And the return code should be 0

  Scenario: Lifecycle Step 4 - Spoke Decommissioning (stop & rm)
    Given "python" is running
    When I execute "bin/vde stop python"
    Then the container "vde-python" should not be running
    And the return code should be 0
    When I execute "bin/vde rm python"
    Then the container "vde-python" should not exist
    And the return code should be 0

  Scenario: Lifecycle Step 5 - Dynamic Expansion (add & uninstall)
    When I execute "bin/vde add --quiet --port 2298 --pkgs 'htop' dynamic-vm"
    Then the command should succeed
    And the VM "vde-dynamic-vm" must be registered as a "language"
    And the setup script for "dynamic-vm" must exist
    When I execute "bin/vde uninstall dynamic-vm --skip-confirm"
    Then the command should succeed
    And the VM "dynamic-vm" should no longer be registered
    And the SSH config should not contain an entry for "vde-dynamic-vm"

  Scenario: The Forge Hardening - Hardened Rebuild
    Given I have a valid VM definition for "python" in the Beskar Registry
    When I execute "bin/vde rebuild --no-cache python"
    Then the command should succeed
    And the Docker image "vde-python" should exist on the Hub
    And the return code should be 0
