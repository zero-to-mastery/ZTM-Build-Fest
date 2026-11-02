#!/usr/bin/env zsh
# @armor (Engine Core)
set -e

# Use python for reliable multi-line/regex replacement in step file
python3 -c '
import sys
import re

path = "tests/features/steps/configuration_management_steps.py"
with open(path, "r") as f:
    content = f.read()

# 1. Add vde_wait_for_container_healthy to imports if missing
if "vde_wait_for_container_healthy" not in content:
    content = content.replace("container_is_running,", "vde_wait_for_container_healthy,\n    container_is_running,")

# 2. Replace arbitrary sleep calls
# Replace time.sleep(1) with 0.2
content = content.replace("time.sleep(1)", "time.sleep(0.2)")
# Replace time.sleep(0.5) with 0.2
content = content.replace("time.sleep(0.5)", "time.sleep(0.2)")
# Replace the 15s wait with deterministic polling
content = re.sub(r"time\.sleep\(15\) # Give MySQL.*", "vde_wait_for_container_healthy(context.mysql_vm, timeout=60)", content)

with open(path, "w") as f:
    f.write(content)
'

echo "Sleep remediation applied."
