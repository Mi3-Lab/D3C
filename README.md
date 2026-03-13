# D3C - Distributed Driving Data Collective

D3C is a distributed driving data research platform where personal smartphones act as fleet nodes.
Each node contributes multimodal driving data to a coordinated fleet session managed by the laptop fleet server.

## Repository Structure

```text
d3c/
  client-mobile/
    phone.html
    phone.js
  dashboard/
    dashboard.html
    dashboard.js
    styles.css
    store.js
    layouts.js
    widgets.js
  fleet-server/
    index.js
    config.js
    compute/
      motion_state.js
    router/
      message_router.js
    shared/
      schema.js
    session/
      session_manager.js
      parquet/
        converter.js
        write_parquet.py
      recorders/
        audio_recorder.js
        audio_wav_recorder.js
        camera_recorder.js
        device_recorder.js
        events_recorder.js
        fusion_recorder.js
        gps_recorder.js
        imu_recorder.js
        net_recorder.js
  datasets/
  docs/
    migration-map.md
    sync-model.md
  certs/
    cert.pem
    key.pem
```

## Fleet Model

- Many phones connect simultaneously (`device_id` per node).
- Dashboard can focus one node while monitoring the fleet.
- Recording scope:
  - focused node
  - all connected nodes
- Session-level stream control (camera/IMU/audio) is global for the active fleet session.
- Device panel is metrics-only (readiness, live rates, dropouts, last-seen), not per-device control.


## Dashboard Operation Model

### Session-level controls (global)

- `Session Setup` is global for the fleet session.
- `Phone Access` includes a join code that phones must enter before they can connect.
- Join code is persisted across server restarts in `fleet-server/auth_state.json`.
- Camera/IMU/Audio toggles and rates are applied to all connected devices via server broadcast.
- Session state is `draft` or `active`.
- While active, config controls are locked and Start/Stop button states are enforced:
  - idle: Start enabled, Stop disabled
  - recording: Start disabled, Stop enabled

### Device-level monitoring (no controls)

The `Devices` panel shows per-device runtime state only:
- readiness (`armed`, `recording`, `not ready`)
- live stream health (`imu hz`, `cam fps`, `gps status`)
- health alerts (low IMU Hz, low camera FPS, stale/no-fix GPS, high RTT, packet drops)
- dropouts
- lastSeen timestamp

If no phones are connected, the table shows an explicit empty state.

### Focused vs All Devices view

- `Focused Device` mode: widgets render a single selected device.
- `All Devices` mode: fleet summary remains active and top hint shows active counts by modality.

### Camera Preview panel states

Camera viewport uses consistent status labels:
- `REC` when camera stream is being recorded
- `LIVE` when streaming but not recording
- `OFFLINE` when no fresh frame is available

Overlay also shows FPS and resolution, with footer device + RTT.

### Recording visibility

- Global banner shows `OFFLINE`, `DEVICES CONNECTING`, `SYSTEM READY`, `RECORDING`, or `DEVICES FLUSHING`.
- `Session Setup` includes inline recording timer text (`Recording - mm:ss elapsed`).
- Sensor panels show modality badges (`REC`/`OFF`) based on writer ACK state.
- Session stop writes sync_report.json with per-device RTT/loss and clock offset+drift stats for alignment QA.
## Modalities

- Motion & Pose: `imu`
- Vision & Environment: `camera`
- Audio: `audio` (`audio.parquet` + `audio.wav`)
- Location & Context: `gps`
- Device State: `device`
- Network & Performance: `net`
- Fusion Metrics: `fusion`

## Storage Format

- Real-time transport remains JSON over WebSocket.
- Canonical on-disk sensor logs are Apache Parquet (`*.parquet`).
- CSV outputs remain as compatibility artifacts during transition.
- Parquet conversion runs automatically when recording stops.

### Canonical Parquet Streams

Per device under `datasets/session_.../devices/<device_id>/streams/`:
- `imu.parquet`
- `gps.parquet`
- `events.parquet`
- `net.parquet`
- `audio.parquet`
- `device.parquet`
- `fusion.parquet`

### IMU Parquet Schema

See `docs/sync-model.md` for continuous offset+drift fitting and reconnect segments.

- `session_id`, `device_id`
- `t_device_ns` (int64)
- `t_wall_utc_ns` (int64)
- `t_server_rx_ns` (int64)
- `t_aligned_utc_ns` (int64, from sync model)
- `accel_x`, `accel_y`, `accel_z`
- `gyro_x`, `gyro_y`, `gyro_z`
- optional placeholders: `mag_x`, `mag_y`, `mag_z`, `sample_rate_hz`, `sensor_frame`

## Install

```powershell
npm install
```

If PowerShell blocks `npm`:

```powershell
& "C:\Program Files\nodejs\npm.cmd" install
```

Install PyArrow for parquet conversion:

```powershell
pip install pyarrow
```

## Certificate Setup (HTTPS)

iPhone sensors require HTTPS.

### Option A (recommended): mkcert

```powershell
winget install FiloSottile.mkcert
mkcert -install
mkdir certs -Force
mkcert -key-file certs\key.pem -cert-file certs\cert.pem localhost 127.0.0.1 ::1 <laptop-ip>
```

Use your active hotspot/Wi-Fi IPv4 for `<laptop-ip>`.

Important: in PowerShell, replace `<laptop-ip>` with the actual IP value (for example `172.20.10.2`). Do not type angle brackets literally.

### Option B (fallback): self-signed cert

Create a self-signed cert with OpenSSL and place files under `certs/`.
Browsers may show warnings with self-signed certs.

## Run

```powershell
node fleet-server\index.js --cert certs\cert.pem --key certs\key.pem --port 8443
```

For local desktop-only testing without HTTPS:

```powershell
node fleet-server\index.js --port 8443
```

If `node` is not in PATH:

```powershell
& "C:\Program Files\nodejs\node.exe" fleet-server\index.js --cert certs\cert.pem --key certs\key.pem --port 8443
```

## Open

- Fleet dashboard: `https://localhost:8443/dashboard`
- Mobile node page: `https://<laptop-ip>:8443/phone`
- Explicit node ID: `https://<laptop-ip>:8443/phone?device_id=iphone-AB12`
- WebSocket endpoint: `wss://<host>:8443/ws`

If you run without certs for local testing, use `http://` and `ws://` instead.

## Phone Join Flow

- Open the dashboard and check `Session Setup` -> `Phone Access` for the current join code.
- On the phone page, enter:
  - `Device Name`
  - `Join Code`
- Tap `Start`.
- Phone auth uses a short-lived join token after the code is validated.
- `POST /api/phone/auth` is rate-limited per client IP to slow repeated guess attempts.

## Dataset APIs

- `GET /api/datasets`
- `GET /api/datasets/:id/manifest` (returns CSV + Parquet URLs + `syncReportJson` when available)
- `POST /api/datasets/:id/encode`
- `DELETE /api/datasets/:id`

Compatibility aliases remain enabled:
- Static: `/sessions/...` -> serves from `datasets/`
- API: `/api/sessions/*` -> HTTP 307 redirect to `/api/datasets/*`

## Camera MP4 Encoding (FFmpeg)

When a recording session stops, D3C can automatically encode camera JPG frames into `camera_video.mp4` and keep the JPG sequence.

Default behavior:
- `streams.camera.auto_mp4_on_stop: true`
- JPG frames in `camera/` are kept
- MP4 output is written as `camera_video.mp4`

### Install FFmpeg (Windows)

```powershell
winget install Gyan.FFmpeg
```

Verify:

```powershell
ffmpeg -version
```

### If FFmpeg is not in PATH

Set the binary path explicitly before starting the server:

```powershell
$env:FFMPEG_BIN="C:\path\to\ffmpeg.exe"
& $env:FFMPEG_BIN -version
```

Then run D3C in the same PowerShell window:

```powershell
& "C:\Program Files\nodejs\node.exe" fleet-server\index.js --cert certs\cert.pem --key certs\key.pem --port 8443
```

### Find `ffmpeg.exe` path

```powershell
Get-ChildItem "C:\Program Files","C:\Program Files (x86)","C:\ffmpeg","C:\tools","$env:LOCALAPPDATA" -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
```

## Dataset Output

```text
datasets/session_YYYYMMDD_HHMMSS/
  meta.json
  control_log.jsonl
  sync_report.json
  devices/
    <device_id>/
      streams/
        imu.parquet (canonical)
        imu.csv (compat)
        gps.parquet (canonical)
        gps.csv (compat)
        events.parquet (canonical)
        events.csv (compat)
        net.parquet (canonical)
        net.csv (compat)
        audio.parquet (canonical)
        audio.csv (compat)
        audio.wav
        device.parquet (canonical)
        device.csv (compat)
        fusion.parquet (canonical)
        fusion.csv (compat)
        camera/*.jpg
        camera_timestamps.csv
        camera_video.mp4
```

## Sync Report Guide

`sync_report.json` is written when a recording session stops.
It summarizes per-device timing quality and stream health for alignment QA.

Location:
- `datasets/session_YYYYMMDD_HHMMSS/sync_report.json`

Example:
```json
{
  "session_id": "8F3A",
  "device_count": 2,
  "devices": {
    "phone1": {
      "sync": {
        "ping_loss_pct": 0.0,
        "rtt_ms": { "mean": 34.2, "min": 21.0, "max": 59.0, "samples": 120 },
        "clock_offset_ms": { "mean": 8.5, "std": 3.1, "min": 1.2, "max": 14.9, "samples": 420 }
      },
      "alerts": []
    }
  }
}
```

Key fields:
- `ping_loss_pct`: estimated ping/pong loss percentage during session.
- `rtt_ms.mean/min/max`: network latency quality per device.
- `clock_offset_ms.mean/std`: relative device-to-server timing drift estimate (lower and more stable is better).
- `alerts`: warnings seen at stop time (for example `imu_low_hz`, `cam_low_fps`, `gps_stale`, `rtt_high`).
## Troubleshooting

- Node/npm not recognized:
  - use full executable paths shown above
- iPhone cannot connect:
  - verify same hotspot/LAN
  - use active IPv4 from `ipconfig` (not virtual adapters)
  - allow inbound TCP 8443 in Windows Firewall
- Parquet files missing:
  - ensure Python + PyArrow are installed (`pip install pyarrow`)
  - set Python binary if needed:
    - `$env:PARQUET_PYTHON_BIN = "C:\path\to\python.exe"`
  - check `control_log.jsonl` for `parquet_convert` result
- Sync report missing or empty:
  - confirm at least one device sent ping/pong and stream data during session
  - check `control_log.jsonl` for `sync_report_written`
- Video not generated:
  - verify FFmpeg works: `& $env:FFMPEG_BIN -version` (or `ffmpeg -version` if in PATH)
  - set FFmpeg path if needed:
    - `$env:FFMPEG_BIN = "C:\path\to\ffmpeg.exe"`
  - confirm `streams.camera.auto_mp4_on_stop` is `true` and camera mode is `stream` during recording




