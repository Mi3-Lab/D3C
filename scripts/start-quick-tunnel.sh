#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-3000}"
HOST="${HOST:-0.0.0.0}"
SERVER_URL="http://127.0.0.1:${PORT}"
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-$ROOT_DIR/.local/bin/cloudflared}"
CLOUDFLARED_PROTOCOL="${CLOUDFLARED_PROTOCOL:-http2}"
RUNTIME_DIR="$ROOT_DIR/tmp"
PUBLIC_RUNTIME_STATE_PATH="${PUBLIC_RUNTIME_STATE_PATH:-$RUNTIME_DIR/quick-tunnel-state.json}"
SERVER_LOG="$(mktemp -t d3c-server.XXXXXX.log)"
TUNNEL_LOG="$(mktemp -t d3c-tunnel.XXXXXX.log)"
WORKZONE_ENABLE="${WORKZONE_ENABLE:-auto}"
WORKZONE_PROJECT_DIR="${WORKZONE_PROJECT_DIR:-/home/proy/projects/mi3/workzone}"
WORKZONE_PYTHON="${WORKZONE_PYTHON:-/home/proy/miniconda3/envs/workzone/bin/python}"
WORKZONE_WEIGHTS="${WORKZONE_WEIGHTS:-weights/yolo12s_hardneg_1280.pt}"
WORKZONE_DEVICE="${WORKZONE_DEVICE:-cpu}"
WORKZONE_LIVE_ENABLE="${WORKZONE_LIVE_ENABLE:-auto}"
WORKZONE_LIVE_IMGSZ="${WORKZONE_LIVE_IMGSZ:-1280}"
WORKZONE_LIVE_CONF="${WORKZONE_LIVE_CONF:-0.18}"
WORKZONE_LIVE_IOU="${WORKZONE_LIVE_IOU:-0.45}"
WORKZONE_LIVE_SCORE_THRESHOLD="${WORKZONE_LIVE_SCORE_THRESHOLD:-0.40}"
WORKZONE_POLL_INTERVAL="${WORKZONE_POLL_INTERVAL:-0.2}"
WORKZONE_OUTPUT_FOLDER_NAME="${WORKZONE_OUTPUT_FOLDER_NAME:-workzone}"
WORKZONE_NO_SAVE_ANNOTATED_FRAMES="${WORKZONE_NO_SAVE_ANNOTATED_FRAMES:-0}"
WORKZONE_NO_SAVE_ANNOTATED_VIDEO="${WORKZONE_NO_SAVE_ANNOTATED_VIDEO:-0}"
WORKZONE_VIDEO_SEGMENT_FRAMES="${WORKZONE_VIDEO_SEGMENT_FRAMES:-}"
WORKZONE_LOG=""
SERVER_PID=""
TUNNEL_PID=""
WORKZONE_PID=""
QUICK_TUNNEL_RETRIES="${QUICK_TUNNEL_RETRIES:-4}"
WORKZONE_ALERT_COOLDOWN_MS="${WORKZONE_ALERT_COOLDOWN_MS:-0}"

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
  if [[ -n "${WORKZONE_PID}" ]] && kill -0 "${WORKZONE_PID}" 2>/dev/null; then
    kill "${WORKZONE_PID}" 2>/dev/null || true
    wait "${WORKZONE_PID}" 2>/dev/null || true
  fi
  rm -f "${PUBLIC_RUNTIME_STATE_PATH}"
  rm -f "${SERVER_LOG}" "${TUNNEL_LOG}"
  if [[ -n "${WORKZONE_LOG}" ]]; then
    rm -f "${WORKZONE_LOG}"
  fi
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

should_start_workzone() {
  local normalized="${WORKZONE_ENABLE,,}"
  case "${normalized}" in
    1|true|yes|on) return 0 ;;
    auto)
      case "${WORKZONE_LIVE_ENABLE,,}" in
        1|true|yes|on) return 1 ;;
        auto)
          if [[ -d "${WORKZONE_PROJECT_DIR}" ]] && [[ -x "${WORKZONE_PYTHON}" ]]; then
            return 1
          fi
          return 0
          ;;
        *) return 0 ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

cd "${ROOT_DIR}"
mkdir -p "${RUNTIME_DIR}"

echo "Starting D3C server on ${SERVER_URL} ..."
PUBLIC_RUNTIME_STATE_PATH="${PUBLIC_RUNTIME_STATE_PATH}" \
WORKZONE_ALERT_COOLDOWN_MS="${WORKZONE_ALERT_COOLDOWN_MS}" \
WORKZONE_LIVE_ENABLE="${WORKZONE_LIVE_ENABLE}" \
WORKZONE_LIVE_PROJECT_DIR="${WORKZONE_PROJECT_DIR}" \
WORKZONE_LIVE_PYTHON="${WORKZONE_PYTHON}" \
WORKZONE_LIVE_WEIGHTS="${WORKZONE_WEIGHTS}" \
WORKZONE_LIVE_DEVICE="${WORKZONE_DEVICE}" \
WORKZONE_LIVE_IMGSZ="${WORKZONE_LIVE_IMGSZ}" \
WORKZONE_LIVE_CONF="${WORKZONE_LIVE_CONF}" \
WORKZONE_LIVE_IOU="${WORKZONE_LIVE_IOU}" \
WORKZONE_LIVE_SCORE_THRESHOLD="${WORKZONE_LIVE_SCORE_THRESHOLD}" \
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

if should_start_workzone; then
  if [[ ! -d "${WORKZONE_PROJECT_DIR}" ]] || [[ ! -x "${WORKZONE_PYTHON}" ]]; then
    if [[ "${WORKZONE_ENABLE,,}" == "auto" ]]; then
      echo "WorkZone runner not started: set WORKZONE_PROJECT_DIR and WORKZONE_PYTHON if you want live WorkZone logs." >&2
    else
      echo "WorkZone runner requested but unavailable." >&2
      echo "WORKZONE_PROJECT_DIR=${WORKZONE_PROJECT_DIR}" >&2
      echo "WORKZONE_PYTHON=${WORKZONE_PYTHON}" >&2
      exit 1
    fi
  else
    WORKZONE_LOG="$(mktemp -t d3c-workzone.XXXXXX.log)"
    WORKZONE_CMD=(
      "${WORKZONE_PYTHON}"
      -B
      -m
      d3c_support.live_runner
      --datasets-root "${ROOT_DIR}/datasets"
      --weights "${WORKZONE_WEIGHTS}"
      --device "${WORKZONE_DEVICE}"
      --poll-interval "${WORKZONE_POLL_INTERVAL}"
      --output-folder-name "${WORKZONE_OUTPUT_FOLDER_NAME}"
    )
    if [[ "${WORKZONE_NO_SAVE_ANNOTATED_FRAMES,,}" =~ ^(1|true|yes|on)$ ]]; then
      WORKZONE_CMD+=(--no-save-annotated-frames)
    fi
    if [[ "${WORKZONE_NO_SAVE_ANNOTATED_VIDEO,,}" =~ ^(1|true|yes|on)$ ]]; then
      WORKZONE_CMD+=(--no-save-annotated-video)
    fi
    if [[ -n "${WORKZONE_VIDEO_SEGMENT_FRAMES}" ]]; then
      WORKZONE_CMD+=(--video-segment-frames "${WORKZONE_VIDEO_SEGMENT_FRAMES}")
    fi
    echo "Starting WorkZone watcher from ${WORKZONE_PROJECT_DIR} ..."
    (
      cd "${WORKZONE_PROJECT_DIR}"
      "${WORKZONE_CMD[@]}"
    ) >"${WORKZONE_LOG}" 2>&1 &
    WORKZONE_PID=$!
    sleep 1
    if ! kill -0 "${WORKZONE_PID}" 2>/dev/null; then
      echo "WorkZone watcher exited during startup:" >&2
      cat "${WORKZONE_LOG}" >&2
      exit 1
    fi
  fi
fi

echo "Opening Cloudflare Quick Tunnel ..."
PUBLIC_URL=""
for attempt in $(seq 1 "${QUICK_TUNNEL_RETRIES}"); do
  : >"${TUNNEL_LOG}"
  "${CLOUDFLARED_BIN}" tunnel --protocol "${CLOUDFLARED_PROTOCOL}" --url "${SERVER_URL}" >"${TUNNEL_LOG}" 2>&1 &
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
      break
    fi
    sleep 1
  done

  if [[ -n "${PUBLIC_URL}" ]]; then
    break
  fi

  if [[ -n "${TUNNEL_PID}" ]] && kill -0 "${TUNNEL_PID}" 2>/dev/null; then
    kill "${TUNNEL_PID}" 2>/dev/null || true
    wait "${TUNNEL_PID}" 2>/dev/null || true
  fi
  TUNNEL_PID=""

  if [[ "${attempt}" -lt "${QUICK_TUNNEL_RETRIES}" ]]; then
    echo "Quick Tunnel attempt ${attempt}/${QUICK_TUNNEL_RETRIES} failed. Retrying..." >&2
    sleep $((attempt * 2))
  fi
done

if [[ -z "${PUBLIC_URL}" ]]; then
  echo "Quick Tunnel failed after ${QUICK_TUNNEL_RETRIES} attempt(s)." >&2
  cat "${TUNNEL_LOG}" >&2
  exit 1
fi

cat >"${PUBLIC_RUNTIME_STATE_PATH}" <<EOF
{"mode":"quick_tunnel","started_at_ms":$(date +%s%3N),"public_url":"${PUBLIC_URL}"}
EOF

echo
echo "Quick Tunnel is up:"
echo "Phone:     ${PUBLIC_URL}/phone"
echo "Dashboard: ${PUBLIC_URL}/dashboard"
echo "Health:    ${PUBLIC_URL}/health"
echo "Protocol:  ${CLOUDFLARED_PROTOCOL}"
echo
echo "Local server logs: ${SERVER_LOG}"
echo "Tunnel logs:       ${TUNNEL_LOG}"
if [[ -n "${WORKZONE_LOG}" ]]; then
  echo "WorkZone logs:     ${WORKZONE_LOG}"
fi
echo
echo "Press Ctrl-C to stop both processes."

wait "${TUNNEL_PID}"
