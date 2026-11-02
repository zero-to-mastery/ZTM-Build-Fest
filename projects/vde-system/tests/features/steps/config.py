#!/usr/bin/env python3
# @forge (Governance Sentinel)
"""
Shared configuration for VDE BDD tests.

This module provides a single source of truth for test configuration.
Import from here rather than duplicating path calculations.
"""

import os
import sys
from pathlib import Path

# Add the tests directory to path so we can import from steps
# This is needed because behave's exec_file doesn't set up proper module paths

# Calculate VDE_ROOT once, correctly
# This file is at: tests/features/steps/config.py
# Project root is 4 levels up
_VDE_ROOT = Path(
    os.environ.get(
        "VDE_ROOT_DIR",
        os.path.dirname(
            os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        ),
    )
)


def get_vde_root() -> Path:
    """Get the VDE project root directory."""
    return _VDE_ROOT


# Export for backwards compatibility
VDE_ROOT = get_vde_root()

# Calculate VDE_HOME and VDE_SSH_DIR
# Use environment variables if set (for test environment overrides)
VDE_HOME = Path(os.environ.get("VDE_HOME_DIR", Path.home()))
VDE_SSH_DIR = Path(os.environ.get("VDE_SSH_DIR", VDE_HOME / ".ssh" / "vde"))
VDE_SSH_CONFIG = VDE_SSH_DIR / "config"
VDE_CACHE_DIR = Path(os.environ.get("VDE_CACHE_DIR", VDE_ROOT / ".cache"))
