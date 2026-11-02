# VDE ARCHITECTURAL RECORD
# @armor (Engine Core — lock release reliability on ZSH 5.8.x)
@core-infrastructure @lock @always-block
Feature: Explicit Sequential Lock Release (ZSH 5.8.x fix)
  As an Alor of the VDE
  I require empirical proof that explicit sequential release_lock fires
  on every ZSH version
  So that stale locks are never left behind by normal function completion

  Background: File-Level Guard Pre-conditions
    Given lib/vm-common does NOT contain the "{always} release_lock" pattern
    And lib/vde-core does NOT contain the "{always} release_lock" pattern
    Given the ".locks" directory exists in the VDE root

  Scenario: Empirical Proof: vm-common load_vm_types releases lock on normal completion
    Given the global-config.lock does NOT exist
    When I source vm-lock and invoke load_vm_types in a sub-shell
    Then the global-config.lock should NOT exist after the call completes

  Scenario: Empirical Proof: vde-core vde_translate_conf_to_json releases lock on normal completion
    Given the global-config.lock does NOT exist
    When I source vm-lock and vde-core and invoke vde_translate_conf_to_json in a sub-shell
    Then the global-config.lock should NOT exist after the call completes
