# D3C

D3C is a local fleet-capture stack for collecting driving data from multiple phones through a single laptop-hosted server.

The repo contains:

- `fleet-server/`: Express + WebSocket server, session management, dataset APIs, sync tracking, and recording/export logic
- `dashboard/`: browser dashboard served at `/dashboard`
- `client-mobile/`: phone web client served at `/phone`
- `docs/`: implementation notes for sync and storage migration
- `certs/`: optional HTTPS certificate files

## Current Behavior

- Phones join a shared fleet session with a join code.
- The dashboard can focus one device for inspection or show all devices.
- Recording is fleet-wide: when recording starts, all currently connected phones are targeted.
- Focus mode affects the UI only. It does not limit which devices are recorded.
- Session stream settings are shared across connected devices through server broadcast.
- Join code state is persisted in `fleet-server/auth_state.json`.

## Default Stream Configuration

The server starts with these defaults from `fleet-server/config.js`:

- `imu`: enabled, `30 Hz`, recorded
- `camera`: off, not recorded
- `gps`: disabled, not recorded
- `audio`: disabled, not recorded
- `device`: enabled, not recorded
- `fusion`: enabled, not recorded
- `events`: recorded
- `net`: recorded

Camera supports:

- `mode`: `off` or `stream`
- `record_mode`: `jpg`, `video`, or `both`
- `encode_timing`: `realtime`, `post_session`, or `manual`

## Install

```powershell
npm install
```

Optional dependencies:

- Parquet conversion: `pip install pyarrow`
- MP4 encoding: install `ffmpeg`

Windows examples:

```powershell
pip install pyarrow
winget install Gyan.FFmpeg
```

## HTTPS Setup

iPhone motion/camera APIs typically require HTTPS.

Recommended with `mkcert`:

```powershell
winget install FiloSottile.mkcert
mkcert -install
New-Item -ItemType Directory -Force certs
mkcert -key-file certs\key.pem -cert-file certs\cert.pem localhost 127.0.0.1 ::1 <laptop-ip>
```

Replace `<laptop-ip>` with the actual IPv4 address of the laptop on the phone's network.

## Run

Default HTTP mode:

```powershell
node fleet-server\index.js
```

Explicit HTTP port:

```powershell
node fleet-server\index.js --port 3000
```

HTTPS mode:

```powershell
node fleet-server\index.js --cert certs\cert.pem --key certs\key.pem --port 8443
```

Supported flags:

- `--port <number>`: default `3000`
- `--cert <path>` and `--key <path>`: enable HTTPS
- `--host <addr>`: default `0.0.0.0`
- `--lan-ip <addr>`: override the LAN IP shown in startup logs

Environment variables:

- `DASHBOARD_PASSWORD`: when set, `/dashboard`, dashboard assets, dashboard WebSocket access, dataset APIs, `/latest.jpg`, and dataset file downloads require dashboard login
- `AUTH_STATE_PATH`: override persisted join-code state path
- `DATASETS_ROOT`: override dataset output root
- `FFMPEG_BIN`: override the ffmpeg binary used for MP4 encoding

## Open

With HTTP on port `3000`:

- Dashboard: `http://localhost:3000/dashboard`
- Phone client: `http://<laptop-ip>:3000/phone`
- Health check: `http://localhost:3000/health`
- WebSocket: `ws://<host>:3000/ws`

With HTTPS on port `8443`:

- Dashboard: `https://localhost:8443/dashboard`
- Phone client: `https://<laptop-ip>:8443/phone`
- Health check: `https://localhost:8443/health`
- WebSocket: `wss://<host>:8443/ws`

If `DASHBOARD_PASSWORD` is set, browsing to `/dashboard` redirects to `/dashboard/login` until you sign in. `/phone` stays public.

Quick Tunnel example with dashboard auth enabled:

```bash
DASHBOARD_PASSWORD='replace-with-a-strong-password' ./scripts/start-quick-tunnel.sh
```

## Phone Join Flow

1. Open the dashboard and read the current join code.
2. Open `/phone` on the device.
3. Enter a device name and the join code.
4. The phone calls `POST /api/phone/auth`.
5. The server returns a short-lived join token.
6. The phone opens the WebSocket and identifies as role `phone`.

Auth notes:

- Join-token TTL is 5 minutes.
- Auth attempts are rate-limited per client IP.
- If a phone reconnects with the same device ID, the server tries to reuse that logical device when safe.

## Dashboard Notes

The dashboard receives:

- live device list and per-device summaries
- focused and all-device state payloads
- session config, session state, and join code
- per-device recording status
- dataset list and storage health via HTTP APIs

Useful behavior details:

- `Focused Device` and `All Devices` are viewing modes.
- The dashboard can rotate the join code.
- Recording banners and per-widget record badges are based on server state and writer activity.

## Recording Model

When recording starts:

- the server records all connected devices
- a new dataset directory is created under `datasets/`
- metadata is written to `meta.json`
- recorder instances are created lazily for streams that are actually written

When recording stops:

- camera finalization tasks are awaited, up to 5 minutes
- `sync_report.json` is written
- CSV-to-Parquet conversion is launched if enabled
- stopped-file hints are published back to the dashboard

Storage cleanup exists in code, but automatic cleanup is disabled by default:

- `storage.auto_cleanup: false`
- `storage.max_session_age_days: 30`
- `storage.max_total_size_gb: 50`
- `storage.on_quota_exceeded: "warn"`

## HTTP APIs

Static pages:

- `GET /dashboard`
- `GET /phone`
- `GET /health`
- `GET /latest.jpg?device_id=<id>`

Phone auth:

- `POST /api/phone/auth`

Datasets:

- `GET /api/datasets`
- `GET /api/datasets/:id/manifest`
- `POST /api/datasets/:id/encode`
- `DELETE /api/datasets/:id`
- `GET /api/storage`

Compatibility aliases:

- `/sessions/...` serves the same files as `/datasets/...`
- `/api/sessions/*` redirects with HTTP `307` to `/api/datasets/*`

## Dataset Layout

Typical output:

```text
datasets/session_YYYYMMDD_HHMMSS/
  meta.json
  control_log.jsonl
  sync_report.json
  devices/
    <device_id>/
      streams/
        imu.csv
        imu.parquet
        gps.csv
        gps.parquet
        events.csv
        events.parquet
        net.csv
        net.parquet
        audio.csv
        audio.parquet
        audio.wav
        device.csv
        device.parquet
        fusion.csv
        fusion.parquet
        camera/
          000001.jpg
          ...
        camera_timestamps.csv
        camera_video.mp4
```

Files are created only for streams that were enabled and actually written.

## Manifest Response

`GET /api/datasets/:id/manifest` returns URLs for the first device in the session, or for `?device_id=<id>` when provided.

Fields can include:

- `metaJson`
- `syncReportJson`
- `imuCsv`, `imuParquet`
- `gpsCsv`, `gpsParquet`
- `eventsCsv`, `eventsParquet`
- `netCsv`, `netParquet`
- `audioCsv`, `audioParquet`, `audioWav`
- `deviceCsv`, `deviceParquet`
- `fusionCsv`, `fusionParquet`
- `cameraTimestampsCsv`
- `cameraVideo`
- `cameraDir`

Missing files are returned as `null`.

## Parquet Conversion

CSV-to-Parquet conversion is handled by `fleet-server/session/parquet/write_parquet.py`.

Current Parquet outputs:

- `imu.parquet`
- `gps.parquet`
- `events.parquet`
- `net.parquet`
- `audio.parquet`
- `device.parquet`
- `fusion.parquet`

Conversion details:

- conversion runs after stop when `parquet.enabled !== false`
- the Python binary defaults to `python`
- override with `PARQUET_PYTHON_BIN`
- results are logged in `control_log.jsonl` as `parquet_convert`

The Parquet writer reads `sync_report.json` and populates aligned timestamps when sync fits are available.

## Camera MP4 Encoding

Camera recording supports JPEG sequence capture plus optional MP4 generation.

Important camera config fields:

- `streams.camera.record`
- `streams.camera.mode`
- `streams.camera.record_mode`
- `streams.camera.encode_timing`
- `streams.camera.auto_mp4_on_stop`
- `streams.camera.video_fps`
- `streams.camera.video_bitrate`
- `streams.camera.video_crf`

Encoding behavior:

- `post_session`: encode on stop
- `manual`: keep frames until `/api/datasets/:id/encode` is called
- `realtime`: camera recorder can encode during capture

Override the ffmpeg binary with:

```powershell
$env:FFMPEG_BIN = "C:\path\to\ffmpeg.exe"
```

## Sync Report

`sync_report.json` is written at session stop and reflects the current sync-tracker model used by the code.

Top-level fields include:

- `generated_at_iso`
- `session_id`
- `recording_mode`
- `target_device_ids`
- `device_count`
- `timedOut`
- `timeout_ms`
- `finalize_tasks`
- `devices`

Each `devices.<device_id>` entry contains:

- `device_id`
- `device_name`
- `connected`
- `connection_status`
- `last_seen_ms`
- `stream_health`
- `sync`
- `alerts`

The current `sync` object contains:

- `ping_sent`
- `ping_acked`
- `ping_loss_pct`
- `mapping`
- `quality`
- `segments`

`mapping` is the best available linear fit from device monotonic time to server time:

- `a_ms`
- `b`

`quality` contains fit metrics such as:

- `n`
- `rtt_mean`
- `rtt_p95`
- `residual_ms`
- `window_ms`

Each segment includes:

- `segment_id`
- `reason`
- `start_server_ms`
- `end_server_ms`
- `duration_ms`
- `ping_sent`
- `ping_acked`
- `ping_loss_pct`
- `fit_window_ms`
- `fit`

## Troubleshooting

- `npm` or `node` not found:
  use the full executable path from your Node install.
- Phone cannot connect:
  confirm the phone and laptop are on the same network, use the correct LAN IPv4, and allow inbound TCP on the selected port.
- Join fails:
  verify the join code shown in the dashboard and retry before the token expires.
- Parquet files missing:
  install `pyarrow`, verify Python is available, and check `control_log.jsonl` for `parquet_convert`.
- Video not generated:
  install `ffmpeg`, set `FFMPEG_BIN` if needed, and confirm camera recording used `mode: "stream"`.
- Unexpected recording scope:
  current code records all connected devices when a session starts.

## Always-On PC Deployment

For an always-on Linux lab machine, the repo now includes:

- `Dockerfile`
- `docker-compose.yml`
- `docs/always-on-pc-deploy.md`

Quick start:

```bash
cp .env.example .env
# edit .env and set TUNNEL_TOKEN=your-cloudflare-tunnel-token
docker compose up -d --build
```

This setup uses:

- Cloudflare Tunnel for public HTTPS access
- Docker volumes for datasets and auth state
- environment overrides for `DATASETS_ROOT` and `AUTH_STATE_PATH`
