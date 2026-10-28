#!/usr/bin/env bash
# Kept so old instructions still work. The real runner is dev.mjs (works in PowerShell too): node dev.mjs --help
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Install Node first (the LTS version): https://nodejs.org"; exit 1; }
exec node dev.mjs ${IP:+--ip "$IP"} "$@"
