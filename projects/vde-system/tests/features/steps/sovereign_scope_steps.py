#!/usr/bin/env python3
# @armor (Sovereign Scope Step Definitions)
from behave import given, when, then
import os
import subprocess
import tempfile
from pathlib import Path

@given('the VDE bin directory is in my PATH')
def step_impl(context):
    vde_bin = str(Path(context.vde_root) / "bin")
    context.env = os.environ.copy()
    context.env["PATH"] = f"{vde_bin}:{context.env['PATH']}"
    context.env["VDE_ROOT_DIR"] = context.vde_root

@given('I am currently in a directory outside of VDE_ROOT_DIR')
def step_impl(context):
    context.temp_dir = tempfile.TemporaryDirectory()
    context.wanderer_cwd = context.temp_dir.name

@when('I execute the wanderer command "{command}"')
def step_impl(context, command):
    # Ensure we run from the wanderer directory
    cwd = getattr(context, 'wanderer_cwd', context.vde_root)
    
    # Prefix 'vde' with absolute path if it's the first word
    if command.startswith("vde "):
        command = f"{context.vde_root}/bin/{command}"
    
    # We use zsh explicitly to match VDE requirements
    process = subprocess.Popen(
        ["zsh", "-c", command],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=cwd,
        env=getattr(context, 'env', os.environ)
    )
    stdout, stderr = process.communicate()
    context.stdout = stdout
    context.stderr = stderr
    
    # Map to critical_steps and system_spine_steps attributes
    context.command_output = stdout + stderr
    context.return_code = process.returncode
    context.last_command_rc = process.returncode
    
    # Create a mock result object for system_spine_steps
    class MockResult:
        def __init__(self, rc, out, err):
            self.returncode = rc
            self.stdout = out
            self.stderr = err
    
    context.last_result = MockResult(process.returncode, stdout, stderr)

@given('the Spoke "{alias}" is uninstalled')
def step_impl(context, alias):
    # Uninstall to ensure a clean state
    subprocess.run(
        ["zsh", "-c", f"{context.vde_root}/bin/vde uninstall {alias} --skip-confirm"],
        cwd=context.vde_root,
        capture_output=True
    )

@then('the output should not contain "{text}"')
def step_impl(context, text):
    combined_output = context.stdout + context.stderr
    assert text not in combined_output, f"Output contained forbidden text: {text}"
