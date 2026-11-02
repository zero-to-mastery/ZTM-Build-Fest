# VDE ARCHITECTURAL RECORD
# @forge (Governance Sentinel)
@core-infrastructure @rust @path
Feature: Rust VM Path Verification
  As a developer using the Rust VM
  I require the Cargo bin directory to be in my PATH
  So that I can execute cargo commands immediately

  Scenario: Verify Cargo is in PATH for interactive shell
    Given the container "vde-rust" is running
    When I execute "bin/vde enter rust 'echo $PATH'"
    Then the output should contain "/home/devuser/.cargo/bin"
    And the return code should be 0

  Scenario: Verify Cargo command is executable
    Given the container "vde-rust" is running
    When I execute "bin/vde enter rust 'cargo --version'"
    Then the output should contain "cargo"
    And the return code should be 0
