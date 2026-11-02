#!/usr/bin/env python3
# @forge (Governance Sentinel)
# VDE ARCHITECTURAL RECORD
from behave import given, when, then
from vm_common import run_vde_command
from shell_helpers import verify_container_running, normalize_vm_name

@given('"{vm_alias}" is running')
def step_vm_is_running(context, vm_alias):
    from shell_helpers import wait_for_container_healthy
    container_name = normalize_vm_name(vm_alias)
    
    # Use canonical vde command to start
    run_vde_command(f"start {vm_alias}")
    wait_for_container_healthy(container_name)
    verify_container_running(container_name)
    context.vm_alias = vm_alias
    context.target_vm = container_name

@when('I execute "{command}" inside "{vm_alias}" to verify DNS')
def step_execute_dns_check(context, command, vm_alias):
    # Use canonical vde exec to test the Transversal Bridge
    res = run_vde_command(f"exec {vm_alias} {command}")
    
    context.command_exit_code = res.returncode
    context.command_output = res.stdout + res.stderr
    context.last_result = res

@then('the output should contain either "{text1}" or "{text2}"')
def step_output_contains_either(context, text1, text2):
    if hasattr(context, "command_output"):
        output = context.command_output
    elif hasattr(context, "last_result"):
        output = context.last_result.stdout + context.last_result.stderr
    else:
        raise AssertionError(
            "No command_output or last_result on context; ensure a preceding step executes a command."
        )

    assert text1 in output or text2 in output, \
        f"Neither '{text1}' nor '{text2}' found in output: {output}"
