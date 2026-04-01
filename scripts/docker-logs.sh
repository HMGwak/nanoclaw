#!/usr/bin/env bash
set -euo pipefail

CORE_CONTAINER="${NANOCLAW_CORE_CONTAINER:-nanoclawcore}"

docker logs -f "${CORE_CONTAINER}"
