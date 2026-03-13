# D3C

D3C lets multiple phones send live data to one server.

Main routes:
- `/dashboard`: control and monitoring UI
- `/phone`: phone client

## Install

```bash
npm install
```

Optional:
- `ffmpeg` for MP4 output
- `pyarrow` for Parquet output

## Run Locally

```bash
node fleet-server/index.js --host 0.0.0.0 --port 3000
```

Open:
- Dashboard: `http://localhost:3000/dashboard`
- Phone: `http://<server-lan-ip>:3000/phone`

Basic flow:
1. Open the dashboard
2. Read the join code
3. Open `/phone` on each device
4. Enter device name and join code
5. Start recording from the dashboard

## Quick Tunnel

Temporary public HTTPS:

```bash
./scripts/start-quick-tunnel.sh
```

With dashboard auth:

```bash
DASHBOARD_PASSWORD='replace-with-a-strong-password' ./scripts/start-quick-tunnel.sh
```

Notes:
- Quick Tunnel URLs are temporary
- the URL usually changes after restart
- datasets stay on this server machine

## Dashboard Auth

To require login for the dashboard and admin/data routes:

```bash
DASHBOARD_PASSWORD='replace-with-a-strong-password' node fleet-server/index.js --host 0.0.0.0 --port 3000
```

`/phone` stays public.

## HTTPS With Local Certs

```bash
node fleet-server/index.js --cert certs/cert.pem --key certs/key.pem --port 8443
```

Open:
- Dashboard: `https://localhost:8443/dashboard`
- Phone: `https://<server-lan-ip>:8443/phone`

## Environment Variables

- `DASHBOARD_PASSWORD`
- `DATASETS_ROOT`
- `AUTH_STATE_PATH`
- `FFMPEG_BIN`

## Data Location

By default, recordings are stored in:

```text
datasets/session_YYYYMMDD_HHMMSS/
```

Typical output includes:
- `meta.json`
- `sync_report.json`
- `devices/<device_id>/streams/imu.csv`
- `devices/<device_id>/streams/gps.csv`
- `devices/<device_id>/streams/net.csv`
- camera/audio/device/fusion files when enabled

## Troubleshooting

- Phone cannot connect: check LAN IP and network
- Dashboard keeps asking for login: restart after changing `DASHBOARD_PASSWORD`
- Quick Tunnel stopped working: rerun `./scripts/start-quick-tunnel.sh`
- No MP4: install `ffmpeg`
- No Parquet: install `pyarrow`
