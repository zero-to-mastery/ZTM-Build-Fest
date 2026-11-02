#!/usr/bin/env python3
# @forge (Governance Sentinel)
from behave import given, when, then
import os
import shutil
import json

@given('I have an intentional version mismatch in "{file_path}"')
def step_impl(context, file_path):
    root = "."
    full_path = os.path.join(root, file_path)
    context.backup_path = full_path + '.bak'
    shutil.copy2(full_path, context.backup_path)

    def _restore():
        if os.path.exists(context.backup_path):
            shutil.move(context.backup_path, full_path)
    context.add_cleanup(_restore)

    with open(full_path, 'r') as f:
        data = json.load(f)

    # Intentional drift
    data['version'] = "9.9.9-drift"

    with open(full_path, 'w') as f:
        json.dump(data, f, indent=2)

@then('I restore "{file_path}" to its original state')
@when('I restore "{file_path}" to its original state')
def step_impl(context, file_path):
    root = "."
    full_path = os.path.join(root, file_path)
    if hasattr(context, 'backup_path') and os.path.exists(context.backup_path):
        shutil.move(context.backup_path, full_path)

@given('I temporarily move "{src}" to "{dst}"')
@when('I temporarily move "{src}" to "{dst}"')
def step_impl(context, src, dst):
    root = os.getcwd()
    full_src = os.path.join(root, src)
    full_dst = os.path.join(root, dst)
    # If dst is a directory, shutil.move will move src INTO it.
    # We want a rename/move to that specific path.
    if os.path.exists(full_dst):
        if os.path.isdir(full_dst):
            shutil.rmtree(full_dst)
        else:
            os.remove(full_dst)
    shutil.move(full_src, full_dst)


@then('I restore "{src}" to "{dst}"')
def step_impl(context, src, dst):
    root = os.getcwd()
    full_src = os.path.join(root, src)
    full_dst = os.path.join(root, dst)
    if os.path.exists(full_src):
        shutil.move(full_src, full_dst)


@given('I create a temporary script "{file_path}"')
def step_impl(context, file_path):
    root = "."
    full_path = os.path.join(root, file_path)
    with open(full_path, 'w') as f:
        f.write("#!/usr/bin/env zsh\n# @forge (Ghost)\ntypeset _zsh_compliance_flag=${(z):-\"zsh native parameter expansion\"}\necho 'Boo'\n")
    os.chmod(full_path, 0o755)
    context.add_cleanup(lambda: os.remove(full_path) if os.path.exists(full_path) else None)

@given('I create a temporary directory "{dir_path}"')
@when('I create a temporary directory "{dir_path}"')
def step_impl(context, dir_path):
    root = "."
    full_path = os.path.join(root, dir_path)
    os.makedirs(full_path, exist_ok=True)

@then('I remove "{file_path}"')
@when('I remove "{file_path}"')
def step_impl(context, file_path):
    root = "."
    full_path = os.path.join(root, file_path)
    if os.path.exists(full_path):
        if os.path.isdir(full_path):
            shutil.rmtree(full_path)
        else:
            os.remove(full_path)
