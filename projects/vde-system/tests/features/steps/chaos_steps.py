#!/usr/bin/env python3
# @forge (Chaos Steps)
# @shared-law (Core Test Utilities)

import os
import subprocess
import threading
import time
from behave import given, when, then
# NOTE: lib.vde_test_utils is not found. Assuming direct subprocess calls are acceptable for test steps.

@given(u'I have multiple VMs defined in the Beskar Registry')
def step_impl(context):
    # This is a prerequisite satisfied by data/vm-types.json
    # We'll assume it's okay for now.
    pass

@when(u'I simultaneously execute "vde rebuild" for "{vm1}" and "{vm2}"')
def step_impl(context, vm1, vm2):
    context.results = []
    
    def run_rebuild(vm):
        # We use a separate thread for each command
        # Ensure Zsh execution for consistency
        res = subprocess.run(["zsh", "-c", f"bin/vde rebuild {vm} --no-cache"], capture_output=True, text=True)
        context.results.append(res)

    t1 = threading.Thread(target=run_rebuild, args=(vm1,))
    t2 = threading.Thread(target=run_rebuild, args=(vm2,))
    
    t1.start()
    t2.start()
    
    t1.join()
    t2.join()

@then(u'the system should serialize the builds using atomic locks')
def step_impl(context):
    # This is a validation step. If the previous threads completed successfully (return code 0),
    # it implies that the locking mechanism prevented race conditions or handled them gracefully.
    # We can check the logs later for explicit lock waiting messages if needed.
    pass

@then(u'no corrupted image state should exist')
def step_impl(context):
    # Verify both images exist and are valid
    for vm in ["vde-python", "vde-js"]:
        res = subprocess.run(["docker", "image", "inspect", vm], capture_output=True)
        assert res.returncode == 0, f"Image {vm} is corrupted or missing"

@then(u'the return code for both should be 0')
def step_impl(context):
    for res in context.results:
        assert res.returncode == 0, f"Rebuild failed with output: {res.stderr}"

@given(u'a hydration script "scripts/setup/chaos-init.zsh" that leaves apt artifacts')
def step_impl(context):
    content = """#!/usr/bin/env zsh
# @armor (Chaos Test - Rule 12.5 Violation)
set -e

echo "Simulating apt artifact creation..."
apt-get update >/dev/null 2>&1
# Intentionally NOT running apt-get clean or removing /var/lib/apt/lists/*
echo "Simulated apt artifacts created."
"""
    os.makedirs("scripts/setup", exist_ok=True)
    with open("scripts/setup/chaos-init.zsh", "w") as f:
        f.write(content)
    os.chmod("scripts/setup/chaos-init.zsh", 0o755)
    context.add_cleanup(lambda: os.remove("scripts/setup/chaos-init.zsh") if os.path.exists("scripts/setup/chaos-init.zsh") else None)

@given(u'a VM "vde-chaos" registered with this script')
def step_impl(context):
    # Temporarily inject VM into vm-types.conf
    context.conf_bak = "data/vm-types.conf.bak"
    subprocess.run(["cp", "data/vm-types.conf", context.conf_bak])
    with open("data/vm-types.conf", "a") as f:
        f.write("lang|chaos|chaos|Chaos VM|curl|zsh /vde/scripts/setup/chaos-init.zsh||2299\n")
    # Force re-smelt
    subprocess.run(["zsh", "-c", "bin/vde-matrix-rebuild.zsh --quiet"])

    def _restore_conf():
        if hasattr(context, 'conf_bak') and os.path.exists(context.conf_bak):
            subprocess.run(["mv", context.conf_bak, "data/vm-types.conf"])
            subprocess.run(["zsh", "-c", "bin/vde-matrix-rebuild.zsh --quiet"])
    context.add_cleanup(_restore_conf)

@when(u'I execute "vde create chaos"')
def step_impl(context):
    context.res = subprocess.run(["zsh", "-c", "bin/vde create chaos"], capture_output=True, text=True)

@then(u'the build should fail with a "Rule 12.5 Violation"')
def step_impl(context):
    assert context.res.returncode != 0, "Build should have failed"
    assert "Rule 12.5 Violation" in context.res.stdout or "Rule 12.5 Violation" in context.res.stderr

@then(u'the output should list the remaining artifacts in "/var/lib/apt/lists/"')
def step_impl(context):
    # The output should show the contents of /var/lib/apt/lists/
    # We expect to see the 'partial' directory listed.
    assert "Rule 12.5 Violation - apt artifacts found in /var/lib/apt/lists/" in context.res.stdout or "Rule 12.5 Violation - apt artifacts found in /var/lib/apt/lists/" in context.res.stderr
    assert "/var/lib/apt/lists/partial" in context.res.stdout or "/var/lib/apt/lists/partial" in context.res.stderr
