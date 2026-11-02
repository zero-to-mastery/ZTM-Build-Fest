#!/bin/bash
# Stops the demo and rebuilds its home.
set -e
cd "$(dirname "$0")"
bash kill.sh
ORB_BIN=${ORB_BIN:-$(cd ../../.. && pwd)/target/release/orb} python3 setup.py
