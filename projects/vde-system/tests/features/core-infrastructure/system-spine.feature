# VDE ARCHITECTURAL RECORD
# @forge (Governance Sentinel)
@core-infrastructure @system-spine @pristine
Feature: System Spine Integrity

  @spine @critical-path @user-guide-first-vm
  Scenario: Hub-to-Spoke Deterministic Ignition
    Given the VDE Hub "data/vm-types.conf" is the sole authority
    And the VDE Registry "data/vm-types.json" is synchronized with the Hub
    When I run the one true way to start "python"
    Then a VM-level lock should be created during ignition
    And the container "vde-python" should be started via direct Docker orchestration
    And the container should have been hydrated by "scripts/setup/python-init.zsh"
    And the SSH port should be atomically allocated and recorded in the registry
    And I should be able to SSH into "vde-python" and verify the environment

  Scenario: Full Language and Service Matrix Verification
    Given the VDE system is healthy
    Then every VM defined in the Hub must have a corresponding USP init script
    And every VM must be startable via the VDE orchestrator
    And every VM must adhere to the 8-field registry standard

  @user-guide-starting-stopping
  Scenario: VM Lifecycle Termination (Stop/Remove)
    Given the VDE Registry is loaded
    And "python" is running
    When I run the one true way to stop "python"
    Then the container "vde-python" should be stopped
    And the VM-level lock should be released
    When I run the one true way to remove "python"
    Then the container "vde-python" should be destroyed
    And the SSH configuration should be preserved

  @bridge @docker-socket
  Scenario: Sovereign Docker Socket Access
    Given the VDE system is healthy
    And "python" is running
    When I execute "docker ps" inside "vde-python" as "devuser"
    Then the command execution should succeed
    And the execution output should contain "vde-python"

  @bridge @docker-socket @host-safety
  Scenario: Host Docker Socket Ownership Is Never Corrupted By A Spoke
    Given the VDE system is healthy
    And "python" is running
    And the host Docker socket group ownership is recorded before ignition
    When I run the one true way to stop "python"
    And I run the one true way to start "python"
    Then the host Docker socket group ownership must be unchanged after ignition

  @bridge @workspace-mount @host-safety
  Scenario: Host Workspace Directory Is Host-Owned After Fresh Ignition
    Given the VDE system is healthy
    And "python" is running
    When I run the one true way to stop "python"
    And the host workspace and logs directories for "python" are removed
    And I run the one true way to start "python"
    Then the host workspace directory for "python" must be owned by the invoking user
    And devuser must be able to write inside the "python" workspace

  @bridge @ssh-forwarding @user-guide-ssh-keys
  Scenario: SSH Agent Forwarding Verification
    Given the VDE system is healthy
    And "python" is running
    And I have identities loaded in my host SSH agent
    When I execute "ssh-add -l" inside "vde-python" as "devuser"
    Then the command execution should succeed
    And the output should contain my host identities

  @system-spine @critical-path @zsh
  Scenario: Pillar I - The Voice of the Tribe (Zsh)
    Given the Hub is active
    When I execute "zsh --version"
    Then the output should contain "zsh 5."
    And the return code should be 0

  @system-spine @critical-path @git
  Scenario: Pillar II - The Chronicler's Record (Git)       # tests/features/core-infrastructure/system-spine.feature:57
    Given a temporary workspace in "plans/scripts/git-test"
    When I execute "git init" in the workspace
    Then the directory ".git" should exist
    And the return code should be 0

  @system-spine @critical-path @docker
  Scenario: Pillar III - The World-Forge (Docker)
    Given the Docker daemon is responsive
    When I run a diagnostic probe with "docker run --rm alpine echo 'Forge Active'"
    Then the output should contain "Forge Active"
    And the return code should be 0

  @system-spine @critical-path @ssh
  Scenario: Pillar IV - The Transversal Bridge (SSH)
    Given the "vde_student" identity exists at "~/.ssh/vde/"
    When the SSH agent is active on the Hub
    And I execute "ssh-add -l"
    Then the loaded SSH identities should include the VDE student key
    And the return code should be 0

  @system-spine @image-purity @rule-12-5
  Scenario: Spoke Image Purity Verification (Rule 12.5)
    Given "python" is running
    Then the directory "/var/lib/apt/lists/" should be empty in the Spoke
    And the directory "~" should contain the required DNA files
