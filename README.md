# D3C

D3C is a small server that lets multiple phones send live sensor and camera data to one dashboard.

Main routes:
- `/dashboard`: operator UI
- `/phone`: phone client

## Install

```bash
npm install
```

Optional:
- `ffmpeg` for MP4 output
- `pyarrow` for Parquet output

## Run on Your Network

```bash
node fleet-server/index.js --host 0.0.0.0 --port 3000
```

Open:
- Dashboard: `http://localhost:3000/dashboard`
- Phone: `http://<server-lan-ip>:3000/phone`

Basic flow:
1. Open `/dashboard`
2. Copy the join code
3. Open `/phone` on each device
4. Enter a device name and the join code
5. Start the device on the phone page
6. Start recording from the dashboard

## Public HTTPS With Quick Tunnel

```bash
./scripts/start-quick-tunnel.sh
```

With dashboard login enabled:

```bash
DASHBOARD_PASSWORD='replace-with-a-strong-password' ./scripts/start-quick-tunnel.sh
```

Notes:
- Quick Tunnel URLs are temporary
- the public URL usually changes on restart
- recordings still stay on this machine

## Dashboard Password

To require login for `/dashboard` and protected dashboard APIs:

```bash
DASHBOARD_PASSWORD='replace-with-a-strong-password' node fleet-server/index.js --host 0.0.0.0 --port 3000
```

`/phone` remains available without dashboard login.

## Local HTTPS

```bash
node fleet-server/index.js --cert certs/cert.pem --key certs/key.pem --port 8443
```

Open:
- Dashboard: `https://localhost:8443/dashboard`
- Phone: `https://<server-lan-ip>:8443/phone`

## Current UI Notes

- Dashboard is dark-mode only
- Dashboard is all-devices only
- Phone UI is dark-mode only
- Phone page shows one checklist-driven device status flow instead of separate status panels

## Environment Variables

- `DASHBOARD_PASSWORD`
- `DATASETS_ROOT`
- `AUTH_STATE_PATH`
- `FFMPEG_BIN`
- `CLOUDFLARED_BIN`
- `PORT`
- `HOST`

## Output

By default, recordings are written under:

```text
datasets/session_YYYYMMDD_HHMMSS/
```

Typical files:
- `meta.json`
- `sync_report.json`
- `devices/<device_id>/streams/net.csv`
- `devices/<device_id>/streams/gps.csv`
- `devices/<device_id>/streams/imu.csv`
- camera/audio/device files when enabled

## Troubleshooting

- Phone cannot connect: check the server IP, firewall, and that the phone is on the same network
- iPhone motion sensors do not work: use Safari and keep the page in the foreground
- Dashboard login keeps failing: restart after changing `DASHBOARD_PASSWORD`
- Quick Tunnel stopped: rerun `./scripts/start-quick-tunnel.sh`
- No MP4 output: install `ffmpeg`
- No Parquet output: install `pyarrow`
