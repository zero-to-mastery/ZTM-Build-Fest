#!/bin/bash
# Stops the demo's orb, its zmx sessions and the fake agents in them.
H=/private/tmp/orbdemo/home
for s in $(env -i HOME=$H ZMX_DIR=$H/.orb/zmx /opt/homebrew/bin/zmx list --short 2>/dev/null); do
  env -i HOME=$H ZMX_DIR=$H/.orb/zmx /opt/homebrew/bin/zmx kill "$s" --force >/dev/null 2>&1
done
pkill -f 'fakeagent.py' 2>/dev/null
pkill -f 'demo/kit/keys.py' 2>/dev/null
sleep 0.5
env -i HOME=$H ZMX_DIR=$H/.orb/zmx /opt/homebrew/bin/zmx list --short 2>/dev/null | grep . && echo "zmx left" || echo clean
