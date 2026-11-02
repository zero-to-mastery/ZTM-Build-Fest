#!/usr/bin/env zsh
# @armor (Engine Core)
#===============================================================================
# VDE-MOTD (Message of the Day)
# Outputs consistent environment metadata for interactive users.
#===============================================================================

# Guard: Only output for interactive TTY sessions
if [[ -t 1 ]]; then
    local _user="${USERNAME:-$(whoami)}"
    # Resolve shell from passwd if environment variable is missing
    local _shell="${SHELL:-$(getent passwd "${_user}" | cut -d: -f7)}"
    
    echo "Hostname: ${HOST:-$(hostname)}"
    echo "User: ${_user}"
    echo "Home Dir: ${HOME}"
    echo "Shell: ${_shell}"
    echo "Workspace: ${HOME}/workspace"
fi
