#!/usr/bin/env bash
set -euo pipefail

CORE_CONTAINER="${NANOCLAW_CORE_CONTAINER:-nanoclawcore}"

echo "== Docker container =="
docker ps --filter "name=${CORE_CONTAINER}" --format "table {{.Names}}\t{{.Status}}\t{{.Image}}"

echo
echo "== Host nanoclaw process check =="
if pgrep -af '[n]ode .*nanoclaw/dist/index.js' >/dev/null; then
  pgrep -af '[n]ode .*nanoclaw/dist/index.js'
else
  echo "none"
fi
