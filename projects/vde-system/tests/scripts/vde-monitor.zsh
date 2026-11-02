#!/usr/bin/env zsh
# @forge (Governance Sentinel)

# VDE Infrastructure Monitor: The "Truth Gate" Dashboard
# Purpose: Real-time visibility into container lifecycles and Exit Codes.
# Usage: ./tests/scripts/vde-monitor.zsh

# Clear the screen for a fresh start
clear

echo "--- VDE LIVE INFRASTRUCTURE MONITOR ---"
echo "Status: Watching for Material Truth..."
echo "Legend: [Timestamp] [Type] [Action] [Container/Actor] [ExitCode]"
echo "------------------------------------------------------------"

# Using the $'...' expansion ensures Zsh interprets \t as actual tabs.
# The 'table' directive automatically generates headers.
docker events --format $'table {{.Time}}\t{{.Type}}\t{{.Action}}\t{{.Actor.Attributes.name}}\t{{index .Actor.Attributes "exitCode"}}'

