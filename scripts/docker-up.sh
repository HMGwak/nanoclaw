#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE_IMAGE="${NANOCLAW_CORE_IMAGE:-nanoclaw-core:latest}"
CORE_CONTAINER="${NANOCLAW_CORE_CONTAINER:-nanoclawcore}"
CORE_NODE_MODULES_VOLUME="${NANOCLAW_CORE_NODE_MODULES_VOLUME:-nanoclawcore-node-modules}"
CORE_NPM_CACHE_VOLUME="${NANOCLAW_CORE_NPM_CACHE_VOLUME:-nanoclawcore-npm-cache}"
CONTAINER_HOME="/home/nanoclaw"
HOST_CONFIG_DIR="${HOME}/.config/nanoclaw"
SECRETARY_VAULT_HOST_PATH="${NANOCLAW_SECRETARY_OBSIDIAN_VAULT_PATH:-}"
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
DOCKER_API_TIMEOUT_SECONDS="${NANOCLAW_DOCKER_API_TIMEOUT_SECONDS:-15}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker command not found"
  exit 1
fi

docker info >/dev/null

DOCKER_API_SOCKET="${HOME}/.docker/run/docker.sock"
if [[ ! -S "${DOCKER_API_SOCKET}" ]]; then
  DOCKER_API_SOCKET="${DOCKER_SOCK_HOST}"
fi
DOCKER_API_VERSION="$(docker version --format '{{.Server.APIVersion}}' 2>/dev/null || echo '1.54')"

docker_api_post() {
  local endpoint="$1"
  curl --silent --show-error --fail \
    --max-time "${DOCKER_API_TIMEOUT_SECONDS}" \
    --unix-socket "${DOCKER_API_SOCKET}" \
    -X POST \
    "http://localhost/v${DOCKER_API_VERSION}${endpoint}" \
    < /dev/null
}

start_container_or_fail() {
  local container_id="$1"
  local label="$2"
  local start_output=""

  if ! start_output="$(docker_api_post "/containers/${container_id}/start" 2>&1)"; then
    echo "Failed to start ${label} within ${DOCKER_API_TIMEOUT_SECONDS}s." >&2
    if [[ -n "${start_output}" ]]; then
      echo "${start_output}" >&2
    fi
    docker ps -a --filter "id=${container_id}" \
      --format "container {{.ID}} {{.Status}} {{.Image}}" >&2 || true
    return 1
  fi
}

verify_bind_mount() {
  local host_path="$1"
  local mount_target="$2"
  local label="$3"
  local check_name="nanoclaw-bind-check-$$-$(date +%s)-$RANDOM"
  local check_id=""
  local state=""

  check_id="$(docker create \
    --name "${check_name}" \
    -v "${host_path}:${mount_target}:ro" \
    --entrypoint /bin/sh \
    node:22-slim \
    -lc "test -e '${mount_target}' && echo BIND_OK" \
  )"

  if ! start_container_or_fail "${check_id}" "bind mount check for ${label}"; then
    docker rm -f "${check_name}" >/dev/null 2>&1 || true
    echo "Docker Desktop cannot start containers with required host bind mount: ${host_path}" >&2
    echo "Manual check: docker run --rm -v '${host_path}:${mount_target}:ro' node:22-slim sh -lc 'echo OK'" >&2
    echo "Check Docker Desktop file sharing / macOS Files & Folders permissions, then retry." >&2
    exit 1
  fi

  state="$(docker inspect --format '{{.State.Status}}' "${check_name}" 2>/dev/null || true)"
  docker rm -f "${check_name}" >/dev/null 2>&1 || true

  if [[ "${state}" = "created" || -z "${state}" ]]; then
    echo "Bind mount check for ${label} did not transition out of Created state." >&2
    echo "Docker Desktop cannot start containers with required host bind mount: ${host_path}" >&2
    echo "Manual check: docker run --rm -v '${host_path}:${mount_target}:ro' node:22-slim sh -lc 'echo OK'" >&2
    echo "Check Docker Desktop file sharing / macOS Files & Folders permissions, then retry." >&2
    exit 1
  fi
}

mkdir -p "${HOST_CONFIG_DIR}"

echo "[0/6] Verifying required Docker bind mounts"
verify_bind_mount "${HOST_CONFIG_DIR}" "/mnt/config" "nanoclaw config"
verify_bind_mount "${PROJECT_ROOT}" "/mnt/project" "NanoClaw project root"

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
PREP_CONTAINER="${CORE_CONTAINER}-prepare-$$"
docker rm -f "${PREP_CONTAINER}" >/dev/null 2>&1 || true
PREP_CONTAINER_ID="$(docker create \
  --name "${PREP_CONTAINER}" \
  -v "${CORE_NODE_MODULES_VOLUME}:${PROJECT_ROOT}/node_modules" \
  -v "${CORE_NPM_CACHE_VOLUME}:${CONTAINER_HOME}/.npm" \
  --entrypoint /bin/sh \
  "${CORE_IMAGE}" \
  -lc "mkdir -p '${PROJECT_ROOT}/node_modules' '${CONTAINER_HOME}/.npm' && chown -R $(id -u):$(id -g) '${PROJECT_ROOT}/node_modules' '${CONTAINER_HOME}/.npm'" \
  )"
docker_api_post "/containers/${PREP_CONTAINER_ID}/start" >/dev/null
PREP_WAIT_RESPONSE="$(docker_api_post "/containers/${PREP_CONTAINER_ID}/wait?condition=not-running")"
PREP_EXIT_CODE="$(printf '%s' "${PREP_WAIT_RESPONSE}" | sed -n 's/.*"StatusCode":[[:space:]]*\([0-9][0-9]*\).*/\1/p')"
if [[ "${PREP_EXIT_CODE}" != "0" ]]; then
  echo "Writable volume prep failed (exit ${PREP_EXIT_CODE})" >&2
  docker logs "${PREP_CONTAINER_ID}" || true
  exit 1
fi
docker rm -f "${PREP_CONTAINER}" >/dev/null 2>&1 || true

ENV_ARGS=()
if [[ -f "${PROJECT_ROOT}/.env" ]]; then
  ENV_ARGS+=(--env-file "${PROJECT_ROOT}/.env")
fi
ENV_ARGS+=(
  -e "NANOCLAW_RUNTIME=docker"
  -e "HOME=${CONTAINER_HOME}"
  -e "TZ=${TZ:-Asia/Seoul}"
)
if [[ -n "${SECRETARY_VAULT_HOST_PATH}" ]]; then
  ENV_ARGS+=(-e "NANOCLAW_SECRETARY_OBSIDIAN_VAULT_PATH=${SECRETARY_VAULT_HOST_PATH}")
  echo "Using secretary vault path: ${SECRETARY_VAULT_HOST_PATH}"
fi
if [[ -z "${ONECLI_URL:-}" ]]; then
  ENV_ARGS+=(-e "ONECLI_URL=http://host.docker.internal:10254")
else
  ENV_ARGS+=(-e "ONECLI_URL=${ONECLI_URL}")
fi

echo "[6/6] Starting core container (${CORE_CONTAINER})"

# Auto-mount allowedRoots from mount-allowlist.json so the core container
# can validate and pass them through to agent containers.
EXTRA_MOUNT_ARGS=()
ALLOWLIST_FILE="${HOST_CONFIG_DIR}/mount-allowlist.json"
if [[ -f "${ALLOWLIST_FILE}" ]] && command -v jq >/dev/null 2>&1; then
  while IFS= read -r mount_path; do
    # Expand ~ to real home
    expanded="${mount_path/#\~/${HOME}}"
    if [[ -d "${expanded}" ]]; then
      verify_bind_mount "${expanded}" "/mnt/allowlist" "allowed root ${expanded}"
      EXTRA_MOUNT_ARGS+=(-v "${expanded}:${expanded}")
    fi
  done < <(jq -r '.allowedRoots[].path' "${ALLOWLIST_FILE}" 2>/dev/null)
fi

CORE_CONTAINER_ID="$(docker create \
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
  -v "${HOME}/.codex:${CONTAINER_HOME}/.codex:ro" \
  "${EXTRA_MOUNT_ARGS[@]}" \
  -w "${PROJECT_ROOT}" \
  "${ENV_ARGS[@]}" \
  --entrypoint /bin/sh \
  "${CORE_IMAGE}" \
  -lc "set -e; LOCK_HASH=\$(sha1sum package-lock.json | awk '{print \$1}'); STAMP_FILE=node_modules/.nanoclaw-lock-hash; if [ ! -f \"\$STAMP_FILE\" ] || [ \"\$(cat \"\$STAMP_FILE\" 2>/dev/null)\" != \"\$LOCK_HASH\" ]; then npm ci --no-audit --no-fund; echo \"\$LOCK_HASH\" > \"\$STAMP_FILE\"; fi; node dist/index.js" \
  )"
start_container_or_fail "${CORE_CONTAINER_ID}" "${CORE_CONTAINER}"
echo "Container started: ${CORE_CONTAINER}"
docker ps --filter "name=${CORE_CONTAINER}" --format "table {{.Names}}\t{{.Status}}\t{{.Image}}"
