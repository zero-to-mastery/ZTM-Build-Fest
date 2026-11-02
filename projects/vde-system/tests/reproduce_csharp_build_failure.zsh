#!/usr/bin/env zsh
# @forge (Governance Sentinel)
# tests/reproduce_csharp_build_failure.zsh

set -e

echo "[TEST] Attempting to rebuild csharp VM..."
# Rebuild csharp VM
bin/vde rebuild csharp
echo "[TEST] Rebuild successful."

# Start csharp VM
bin/vde start csharp
echo "[TEST] Start successful."

# Verify dotnet
echo "[TEST] Verifying dotnet installation..."
bin/vde enter csharp dotnet --version
