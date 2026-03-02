# D3C Time Sync Model (Offset + Drift)

D3C uses continuous NTP-style ping/pong between fleet-server and each phone to estimate both clock offset and drift over long sessions.

## Protocol

Server -> Phone (1 Hz per connected device):
- `sync_ping`
- Fields: `ping_id`, `t1_server_send_ms`

Phone -> Server (immediate response):
- `sync_pong`
- Fields:
  - `ping_id`
  - `t1_server_send_ms`
  - `t2_device_recv_mono_ms`
  - `t3_device_send_mono_ms`
  - `t2_wall_utc_ms` (logging)
  - `t3_wall_utc_ms` (logging)

Phone monotonic time is `performance.now()` (`t_device_ms`/mono), which avoids wall-clock jumps.

## Fitting Model

Per device, server fits:

`t_server_ms ≈ a_ms + b * t_device_ms`

Where:
- `a_ms`: offset term
- `b`: drift term (near 1.0)

For each pong sample:
- `x = (t2 + t3) / 2` (device mono ms)
- `y = (t1 + t4) / 2` (server wall ms)
- `rtt = (t4 - t1) - (t3 - t2)`

Server uses rolling-window weighted linear regression (SyncTracker):
- Window: 120s
- Low-RTT subset preference
- Weight ~ `1 / (rtt^2 + eps)`

## Reconnects and Segments

When a known `device_id` reconnects, server reuses the same device entry and starts a new sync segment.

`sync_report.json` stores:
- Overall per-device mapping and quality
- Segment list with per-segment fit/RTT/loss stats

This preserves timeline continuity while tracking sync quality changes across reconnects.

## Recording and Output Fields

Server stamps receive time on incoming stream packets:
- `t_server_rx_ns` (nanoseconds)

Raw stream files keep original device timing + server receive timing.

Parquet conversion adds aligned time:
- `t_device_ns` (raw device mono)
- `t_wall_utc_ns` (raw receive-based wall)
- `t_server_rx_ns` (server receive)
- `t_aligned_utc_ns` (computed)

Alignment formula:

`t_aligned_utc_ns = (a_ms + b * t_device_ms) * 1e6`

If segment fits exist, converter chooses segment by `t_server_rx_ns` interval; otherwise it falls back to device-level mapping.
