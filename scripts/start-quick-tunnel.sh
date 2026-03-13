#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-3000}"
HOST="${HOST:-0.0.0.0}"
SERVER_URL="http://127.0.0.1:${PORT}"
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-$ROOT_DIR/.local/bin/cloudflared}"
SERVER_LOG="$(mktemp -t d3c-server.XXXXXX.log)"
TUNNEL_LOG="$(mktemp -t d3c-tunnel.XXXXXX.log)"
SERVER_PID=""
TUNNEL_PID=""

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  if [[ -n "${TUNNEL_PID}" ]] && kill -0 "${TUNNEL_PID}" 2>/dev/null; then
    kill "${TUNNEL_PID}" 2>/dev/null || true
    wait "${TUNNEL_PID}" 2>/dev/null || true
  fi
  if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
  rm -f "${SERVER_LOG}" "${TUNNEL_LOG}"
  exit "${exit_code}"
}

trap cleanup EXIT INT TERM

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd node
require_cmd curl

if [[ ! -x "${CLOUDFLARED_BIN}" ]]; then
  echo "cloudflared not found at ${CLOUDFLARED_BIN}" >&2
  echo "Download it first or set CLOUDFLARED_BIN to the correct path." >&2
  exit 1
fi

if [[ ! -d "${ROOT_DIR}/node_modules" ]]; then
  echo "node_modules is missing. Run 'npm install' in ${ROOT_DIR} first." >&2
  exit 1
fi

cd "${ROOT_DIR}"

echo "Starting D3C server on ${SERVER_URL} ..."
node fleet-server/index.js --host "${HOST}" --port "${PORT}" >"${SERVER_LOG}" 2>&1 &
SERVER_PID=$!

for _ in {1..30}; do
  if curl -fsS "${SERVER_URL}/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "Server exited during startup:" >&2
    cat "${SERVER_LOG}" >&2
    exit 1
  fi
  sleep 1
done

if ! curl -fsS "${SERVER_URL}/health" >/dev/null 2>&1; then
  echo "Server did not become healthy within 30 seconds." >&2
  cat "${SERVER_LOG}" >&2
  exit 1
fi

echo "Opening Cloudflare Quick Tunnel ..."
"${CLOUDFLARED_BIN}" tunnel --url "${SERVER_URL}" >"${TUNNEL_LOG}" 2>&1 &
TUNNEL_PID=$!

PUBLIC_URL=""
for _ in {1..45}; do
  if [[ -z "${PUBLIC_URL}" ]]; then
    PUBLIC_URL="$(grep -o 'https://[-[:alnum:]]*\.trycloudflare\.com' "${TUNNEL_LOG}" | head -n 1 || true)"
  fi
  if [[ -n "${PUBLIC_URL}" ]]; then
    break
  fi
  if ! kill -0 "${TUNNEL_PID}" 2>/dev/null; then
    echo "cloudflared exited during startup:" >&2
    cat "${TUNNEL_LOG}" >&2
    exit 1
  fi
  sleep 1
done

if [[ -z "${PUBLIC_URL}" ]]; then
  echo "Timed out waiting for a Quick Tunnel URL." >&2
  cat "${TUNNEL_LOG}" >&2
  exit 1
fi

echo
echo "Quick Tunnel is up:"
echo "Phone:     ${PUBLIC_URL}/phone"
echo "Dashboard: ${PUBLIC_URL}/dashboard"
echo "Health:    ${PUBLIC_URL}/health"
echo
echo "Local server logs: ${SERVER_LOG}"
echo "Tunnel logs:       ${TUNNEL_LOG}"
echo
echo "Press Ctrl-C to stop both processes."

wait "${TUNNEL_PID}"
