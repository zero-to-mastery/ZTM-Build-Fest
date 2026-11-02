#!/bin/bash
# Records a tape against a fresh demo home: bash rec.sh <tape> [shots-dir]
cd "$(dirname "$0")"
bash reset.sh >/dev/null || exit 1
rm -rf "${2:-shots}" && mkdir -p "${2:-shots}"
vhs "$1" > vhs.log 2>&1
status=$?
bash kill.sh
tail -3 vhs.log
ls "${2:-shots}"
exit $status
