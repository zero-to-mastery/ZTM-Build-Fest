#!/usr/bin/env python3
# @forge (Governance Sentinel)
# VDE ARCHITECTURAL RECORD
from behave import given, when, then
import os
import shutil
from pathlib import Path
from vm_common import VDE_ROOT, run_vde_command

@given('I corrupt the Beskar Registry "{path}" with invalid content')
def step_corrupt_registry(context, path):
    file_path = VDE_ROOT / path
    context.registry_backup = file_path.with_suffix(".bak")
    shutil.copy(file_path, context.registry_backup)
    with open(file_path, 'w') as f:
        f.write("{ INVALID JSON CORRUPTION }")

@then('the registry "{path}" should be restored from the Authority')
def step_verify_registry_restored(context, path):
    file_path = VDE_ROOT / path
    import json
    try:
        with open(file_path, 'r') as f:
            json.load(f)
        # If it parses as JSON, it's restored
    finally:
        if hasattr(context, 'registry_backup') and context.registry_backup.exists():
            shutil.move(context.registry_backup, file_path)

@then('the schema validation must pass for "{path}"')
def step_verify_schema_pass(context, path):
    result = run_vde_command("validate")
    assert result.returncode == 0, f"Schema validation failed: {result.stdout}"

@given('I intentionally drift the version in "{path}" to "{version}"')
def step_drift_version(context, path, version):
    file_path = VDE_ROOT / path
    context.file_backup = file_path.with_suffix(".bak")
    shutil.copy(file_path, context.file_backup)
    
    with open(file_path, 'r') as f:
        content = f.read()
    
    # Use simple replacement for simulation
    import re
    new_content = re.sub(r'1\.5\.0', version, content)
    with open(file_path, 'w') as f:
        f.write(new_content)

@then('the Gospel Audit must report "{status}"')
def step_verify_gospel_status(context, status):
    result = run_vde_command("audit")
    output = (result.stdout + result.stderr).lower()
    assert status.lower() in output, f"Expected status '{status}' not found in audit output: {output}"
    # Cleanup backup if present
    if hasattr(context, 'file_backup') and context.file_backup.exists():
        os.remove(context.file_backup)

@given('I inject an absolute path "{path}" into a temporary script')
def step_inject_path_leak(context, path):
    leak_script = VDE_ROOT / "bin" / "temp-leak-test.zsh"
    # Unmask the path from the feature file so it actually triggers the alarm
    actual_path = path.replace("[U]sers", "Users").replace("[h]ome", "home").replace("/[U]", "/U")
    with open(leak_script, 'w') as f:
        f.write(f"#!/usr/bin/env zsh\n# @armor (Leak Test)\nLEAK=\"{actual_path}\"\n")
    context.leak_script = leak_script

@then('the UAP Enforcer should detect the blockade')
def step_verify_blockade(context):
    exit_code = getattr(context, 'command_exit_code', -1)
    output = getattr(context, 'command_output', "")
    assert exit_code == 1, f"Expected exit code 1, but got {exit_code}. Output: {output}"
    assert "Absolute Path Leaks Detected" in output, f"Expected path leak detection not found in output: {output}"
    if hasattr(context, 'leak_script') and context.leak_script.exists():
        os.remove(context.leak_script)

@then('the file "{path}" should contain the Sovereign Baseline version "{version}"')
def step_verify_file_version(context, path, version):
    file_path = VDE_ROOT / path
    with open(file_path, 'r') as f:
        content = f.read()
    assert version in content, f"Version {version} not found in {path}"
