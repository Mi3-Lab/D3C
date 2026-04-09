# D3C

D3C is a server that lets multiple phones stream live sensor and camera data to a single operator dashboard. Phones connect over the internet via a Cloudflare Quick Tunnel — no local network required, no firewall config, works from anywhere.

## How It Works

1. You run the server on your machine — it starts a local Node.js server and opens a public HTTPS tunnel via Cloudflare.
2. You open the dashboard in your browser at the printed local URL.
3. You copy the join code from the dashboard and share the phone URL with anyone who needs to connect.
4. Each person opens the phone URL on their device, enters a name and the join code, and starts streaming.
5. You start and stop recordings from the dashboard.

Recordings are saved locally on your machine regardless of where the phones are.

## Requirements

- **Node.js** (v18 or later recommended)
- **cloudflared** — the Cloudflare tunnel binary
- **ffmpeg** (optional) — required for MP4 camera output
- **pyarrow** (optional) — required for Parquet output

## Install

### 1. Install Node.js dependencies

```bash
npm install
```

This installs the two runtime dependencies: `express` (HTTP server) and `ws` (WebSocket server).

### 2. Install cloudflared

Download the binary for your platform from Cloudflare:
https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

Place it at `.local/bin/cloudflared` inside the project and make it executable:

```bash
mkdir -p .local/bin
mv ~/Downloads/cloudflared .local/bin/cloudflared
chmod +x .local/bin/cloudflared
```

Alternatively, point to an existing install via the environment variable:

```bash
CLOUDFLARED_BIN=/usr/local/bin/cloudflared ./scripts/start-quick-tunnel.sh
```

### 3. Install ffmpeg (optional)

Required only if you want MP4 output from camera streams.

**macOS:**
```bash
brew install ffmpeg
```

**Ubuntu/Debian:**
```bash
sudo apt install ffmpeg
```

**Windows (WSL):**
```bash
sudo apt install ffmpeg
```

### 4. Install pyarrow (optional)

Required only if you want Parquet output.

```bash
pip install pyarrow
```

## Start

```bash
./scripts/start-quick-tunnel.sh
```

With dashboard password protection enabled:

```bash
DASHBOARD_PASSWORD='replace-with-a-strong-password' ./scripts/start-quick-tunnel.sh
```

Once running, the script prints:

```
Phone:     https://xxxx.trycloudflare.com/phone
Dashboard: https://xxxx.trycloudflare.com/dashboard
```

- Open the **Dashboard** URL in your browser to manage devices and recordings.
- Share the **Phone** URL with anyone who needs to connect as a device.

The tunnel URL is temporary and changes each time you restart.

## Connecting a Phone

1. Open the phone URL in a mobile browser (Safari on iPhone, Chrome on Android).
2. Enter a device name.
3. Enter the join code shown on the dashboard.
4. Tap **Start** — the phone will begin streaming sensor data.

> **iPhone note:** Motion sensors require Safari and the page must stay in the foreground.

## Dashboard Password

If `DASHBOARD_PASSWORD` is set, `/dashboard` and all dashboard APIs require login. The `/phone` page is always public so devices can connect without a password.

## Output

Recordings are written to:

```
datasets/session_YYYYMMDD_HHMMSS/
```

Each session contains:

- `meta.json` — session metadata
- `sync_report.json` — device sync summary
- `devices/<device_id>/streams/net.csv` — network timing
- `devices/<device_id>/streams/gps.csv` — GPS data
- `devices/<device_id>/streams/imu.csv` — accelerometer/gyroscope data
- Camera and audio files (when enabled and `ffmpeg` is installed)

## Environment Variables

| Variable | Description |
|---|---|
| `DASHBOARD_PASSWORD` | Enables dashboard login when set |
| `CLOUDFLARED_BIN` | Path to `cloudflared` binary (default: `.local/bin/cloudflared`) |
| `DATASETS_ROOT` | Where recordings are saved (default: `datasets/`) |
| `AUTH_STATE_PATH` | Path to auth state file |
| `FFMPEG_BIN` | Path to `ffmpeg` binary |
| `PORT` | Server port (default: `3000`) |
| `HOST` | Server bind address (default: `0.0.0.0`) |

## Troubleshooting

- **Phone cannot connect** — make sure you're using the full tunnel URL (`https://xxxx.trycloudflare.com/phone`), not a local IP.
- **Join code rejected** — codes expire; copy a fresh one from the dashboard.
- **Quick Tunnel stopped** — rerun `./scripts/start-quick-tunnel.sh`.
- **iPhone motion sensors not working** — use Safari and keep the page open in the foreground.
- **No MP4 output** — install `ffmpeg`.
- **No Parquet output** — install `pyarrow`.
- **`cloudflared` not found** — download it and place it at `.local/bin/cloudflared`, or set `CLOUDFLARED_BIN`.
