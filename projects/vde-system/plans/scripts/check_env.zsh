#!/usr/bin/env zsh
# @armor (Engine Core)
zmodload zsh/zselect 2>/dev/null && echo "zselect: OK" || echo "zselect: MISSING"
zmodload zsh/datetime 2>/dev/null && echo "datetime: OK" || echo "datetime: MISSING"
uptime
ps aux | grep vde | grep -v grep | wc -l
