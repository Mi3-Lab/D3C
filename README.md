# D3C - Distributed Driving Data Collective

D3C is a distributed driving data research platform where personal smartphones act as fleet nodes.
Each node contributes multimodal driving data to a coordinated fleet session managed by the laptop fleet server.

## Repository Structure (Migrated)

```text
d3c/
  client-mobile/
    phone.html
    phone.js
  dashboard/
    dashboard.html
    dashboard.js
    styles.css
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
    session_YYYYMMDD_HHMMSS/
      meta.json
      control_log.jsonl
      devices/<device_id>/streams/...
  docs/
    migration-map.md
  certs/
    cert.pem
    key.pem
```

## Fleet Model

- Many phones connect simultaneously (`device_id` per node).
- Dashboard selects a focused node for live panels.
- Recording scope:
  - focused node
  - all connected nodes
- Per-node stream control with independent production and recording toggles.

## Modalities

- Motion & Pose: `imu`
- Vision & Environment: `camera`
- Audio: `audio` (`audio.csv` + `audio.wav`)
- Location & Context: `gps`
- Device State: `device`
- Network & Performance: `net`
- Fusion Metrics: `fusion`

## Install

```powershell
npm install
```

If PowerShell blocks `npm`:

```powershell
& "C:\Program Files\nodejs\npm.cmd" install
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

Use your active hotspot/Wi-Fi IPv4 for `<laptop-ip>` (example: `172.20.10.2`).

### Option B (fallback): self-signed cert

Create a self-signed cert with OpenSSL and place files under `certs/`.
Browsers may show warnings with self-signed certs.

## Run

```powershell
node fleet-server\index.js --cert certs\cert.pem --key certs\key.pem --port 8443
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

## Dataset APIs

- `GET /api/datasets`
- `GET /api/datasets/:id/manifest`
- `POST /api/datasets/:id/encode`
- `DELETE /api/datasets/:id`

Compatibility aliases remain enabled:
- Static: `/sessions/...` -> serves from `datasets/`
- API: `/api/sessions/*` -> HTTP 307 redirect to `/api/datasets/*`

## Dataset Output

```text
datasets/session_YYYYMMDD_HHMMSS/
  meta.json
  control_log.jsonl
  devices/
    <device_id>/
      streams/
        imu.csv
        camera/*.jpg
        camera_timestamps.csv
        camera_video.mp4
        gps.csv
        audio.csv
        audio.wav
        device.csv
        fusion.csv
        events.csv
        net.csv
```

## Troubleshooting

- Node/npm not recognized:
  - use full executable paths shown above
- iPhone cannot connect:
  - verify same hotspot/LAN
  - use active IPv4 from `ipconfig` (not virtual adapters)
  - allow inbound TCP 8443 in Windows Firewall
- Video not generated:
  - verify `ffmpeg -version`
  - set FFmpeg path if needed:
    - `$env:FFMPEG_BIN = "C:\path\to\ffmpeg.exe"`

