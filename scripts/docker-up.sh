#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE_IMAGE="${NANOCLAW_CORE_IMAGE:-nanoclaw-core:latest}"
CORE_CONTAINER="${NANOCLAW_CORE_CONTAINER:-nanoclawcore}"
CORE_NODE_MODULES_VOLUME="${NANOCLAW_CORE_NODE_MODULES_VOLUME:-nanoclawcore-node-modules}"
CORE_NPM_CACHE_VOLUME="${NANOCLAW_CORE_NPM_CACHE_VOLUME:-nanoclawcore-npm-cache}"
CONTAINER_HOME="/home/nanoclaw"
HOST_CONFIG_DIR="${HOME}/.config/nanoclaw"
DOCKER_SOCK_HOST="/var/run/docker.sock"
if [[ -L "${DOCKER_SOCK_HOST}" ]]; then
  LINK_TARGET="$(readlink "${DOCKER_SOCK_HOST}")"
  if [[ "${LINK_TARGET}" = /* ]]; then
    DOCKER_SOCK_HOST="${LINK_TARGET}"
  else
    DOCKER_SOCK_HOST="$(cd "$(dirname "${DOCKER_SOCK_HOST}")" && pwd)/${LINK_TARGET}"
  fi
fi
SOCKET_GID="$(stat -f '%g' "${DOCKER_SOCK_HOST}" 2>/dev/null || stat -c '%g' "${DOCKER_SOCK_HOST}")"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker command not found"
  exit 1
fi

docker info >/dev/null

mkdir -p "${HOST_CONFIG_DIR}"

echo "[1/6] Building host runtime (dist)"
(
  cd "${PROJECT_ROOT}"
  npm run build
)

echo "[2/6] Building agent runtime image (nanoclaw-agent:latest)"
(
  cd "${PROJECT_ROOT}"
  ./container/build.sh latest
)

echo "[3/6] Building core runtime image (${CORE_IMAGE})"
docker build \
  -t "${CORE_IMAGE}" \
  -f "${PROJECT_ROOT}/container/core.Dockerfile" \
  "${PROJECT_ROOT}"

echo "[4/6] Removing old core container (if any)"
docker rm -f "${CORE_CONTAINER}" >/dev/null 2>&1 || true

echo "[5/6] Preparing writable volumes"
docker run --rm \
  -v "${CORE_NODE_MODULES_VOLUME}:${PROJECT_ROOT}/node_modules" \
  -v "${CORE_NPM_CACHE_VOLUME}:${CONTAINER_HOME}/.npm" \
  --entrypoint /bin/sh \
  "${CORE_IMAGE}" \
  -lc "mkdir -p '${PROJECT_ROOT}/node_modules' '${CONTAINER_HOME}/.npm' && chown -R $(id -u):$(id -g) '${PROJECT_ROOT}/node_modules' '${CONTAINER_HOME}/.npm'"

ENV_ARGS=()
if [[ -f "${PROJECT_ROOT}/.env" ]]; then
  ENV_ARGS+=(--env-file "${PROJECT_ROOT}/.env")
fi
ENV_ARGS+=(
  -e "NANOCLAW_RUNTIME=docker"
  -e "HOME=${CONTAINER_HOME}"
  -e "TZ=${TZ:-Asia/Seoul}"
)
if [[ -z "${ONECLI_URL:-}" ]]; then
  ENV_ARGS+=(-e "ONECLI_URL=http://host.docker.internal:10254")
else
  ENV_ARGS+=(-e "ONECLI_URL=${ONECLI_URL}")
fi

echo "[6/6] Starting core container (${CORE_CONTAINER})"
docker run -d \
  --name "${CORE_CONTAINER}" \
  --restart unless-stopped \
  --user "$(id -u):$(id -g)" \
  --group-add 0 \
  --group-add "${SOCKET_GID}" \
  --add-host=host.docker.internal:host-gateway \
  -v "${DOCKER_SOCK_HOST}:/var/run/docker.sock" \
  -v "${PROJECT_ROOT}:${PROJECT_ROOT}" \
  -v "${CORE_NODE_MODULES_VOLUME}:${PROJECT_ROOT}/node_modules" \
  -v "${CORE_NPM_CACHE_VOLUME}:${CONTAINER_HOME}/.npm" \
  -v "${HOST_CONFIG_DIR}:${CONTAINER_HOME}/.config/nanoclaw" \
  -w "${PROJECT_ROOT}" \
  "${ENV_ARGS[@]}" \
  --entrypoint /bin/sh \
  "${CORE_IMAGE}" \
  -lc "set -e; LOCK_HASH=\$(sha1sum package-lock.json | awk '{print \$1}'); STAMP_FILE=node_modules/.nanoclaw-lock-hash; if [ ! -f \"\$STAMP_FILE\" ] || [ \"\$(cat \"\$STAMP_FILE\" 2>/dev/null)\" != \"\$LOCK_HASH\" ]; then npm ci --no-audit --no-fund; echo \"\$LOCK_HASH\" > \"\$STAMP_FILE\"; fi; node dist/index.js"

echo "Container started: ${CORE_CONTAINER}"
docker ps --filter "name=${CORE_CONTAINER}" --format "table {{.Names}}\t{{.Status}}\t{{.Image}}"
