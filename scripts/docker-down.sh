#!/usr/bin/env bash
set -euo pipefail

CORE_CONTAINER="${NANOCLAW_CORE_CONTAINER:-nanoclawcore}"

docker rm -f "${CORE_CONTAINER}" >/dev/null 2>&1 || true
echo "Container removed: ${CORE_CONTAINER}"
