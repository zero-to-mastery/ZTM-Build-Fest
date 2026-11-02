#!/usr/bin/env python3
# @shared-law (Portability Step Definitions)
import os
import subprocess
from behave import given, when, then
from pathlib import Path

# Mock result class to satisfy system_spine_steps.py
class MockResult:
    def __init__(self, rc, out, err):
        self.returncode = rc
        self.stdout = out
        self.stderr = err

@given('I change the current working directory to "{path}"')
def step_impl(context, path):
    context.original_cwd = os.getcwd()
    context.add_cleanup(lambda: os.chdir(context.original_cwd))
    os.chdir(path)
    context.current_cwd = os.getcwd()

@when('I execute the absolute path of "bin/vde" with "{args}"')
def step_impl(context, args):
    vde_root = getattr(context, "vde_root", context.original_cwd)
    vde_path = os.path.join(vde_root, "bin/vde")
    
    cmd = ["zsh", "-f", "-c", f"{vde_path} {args}"]
    result = subprocess.run(cmd, capture_output=True, text=True)
    
    context.stdout = result.stdout
    context.stderr = result.stderr
    context.return_code = result.returncode
    context.command_output = result.stdout + result.stderr
    context.last_result = MockResult(result.returncode, result.stdout, result.stderr)

@when('I source the absolute path of "lib/vde-constants" in a new Zsh shell')
def step_impl(context):
    vde_root = getattr(context, "vde_root", context.original_cwd)
    vde_constants_path = os.path.join(vde_root, "lib/vde-constants")
    
    cmd = ["zsh", "-f", "-c", f"source {vde_constants_path} && echo $VDE_ROOT_DIR"]
    result = subprocess.run(cmd, capture_output=True, text=True)
    
    context.vde_root_result = result.stdout.strip()
    context.return_code = result.returncode
    context.command_output = result.stdout + result.stderr
    context.last_result = MockResult(result.returncode, result.stdout, result.stderr)

@then('the variable "VDE_ROOT_DIR" should point to the VDE installation directory')
def step_impl(context):
    vde_root = getattr(context, "vde_root", context.original_cwd)
    assert Path(context.vde_root_result).resolve() == Path(vde_root).resolve()
    os.chdir(context.original_cwd)

@then('the variable "VDE_ROOT_DIR" should not be "."')
def step_impl(context):
    assert context.vde_root_result != "."
