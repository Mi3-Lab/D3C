# PhoneSense MVP

PhoneSense is a local-only multimodal sensing platform:
- iPhone page (`/phone`) captures IMU + camera and streams to laptop.
- Dashboard (`/dashboard`) controls stream config, recording, events, and live monitoring.
- Node.js HTTPS + WebSocket server runs entirely on your Windows laptop.

## Features

- Multi-phone support: connect multiple iPhones simultaneously (`device_id` per phone).
- Dashboard device manager: select focused device and view per-device live panels.
- Recording scope:
  - Start Focused Device
  - Start All Devices
  - Supports simultaneous multi-phone recording in one session folder
- Modular stream control: `enabled` and `record` are independent per stream.
- Modalities architecture:
  - Motion & Pose (`imu`)
  - Vision & Environment (`camera`)
  - Audio (`audio`)
  - Location & Context (`gps`)
  - Device State (`device`)
  - Network & Performance (`net`)
  - Multimodal Fusion (`fusion`)
- Presets: IMU-only, Camera-only, No-camera privacy, Full-multimodal.
- Custom preset tools: save current, export JSON, import JSON.
- Camera recording output mode: `jpg` sequence, `video` (FFmpeg on laptop), or `both`.
- Camera encoding timing: `post_session` (default), `manual`, or `realtime`.
- Live health strip: IMU Hz, camera FPS, dropped packets, RTT, recording elapsed, lighting score.
- Motion analytics: `STILL | MOVING | HIGH` + confidence + inactivity duration.
- Privacy-aware camera modes: `off`, `preview` (no stream/record), `stream`.
- Stream status table: enabled/recording/rate/last seen for each stream.
- Event timeline with timestamped tags.
- Replay Session panel: load recorded sessions and replay IMU/events/camera frames or MP4.
- Audio capture:
  - `audio.csv` (amplitude/noise metrics)
  - `audio.wav` (raw mono PCM16 mic recording)
- Reliability layer:
  - phone reconnection with exponential backoff
  - heartbeat messages
  - bounded offline JSON queue
  - wake lock / silent-audio fallback to reduce iPhone sleep interruptions
- Performance protections:
  - server-side stream rate gates
  - WebSocket bufferedAmount backpressure guard
- Storage tools:
  - `/api/storage` monitor endpoint (session size + free disk estimate)
  - session delete API
  - manual video encode API for replay sessions
  - optional cleanup policy (`auto_cleanup`, quota, delete-oldest or block start)
- Session recording with per-stream files only when that stream is recording.

## Project Structure

```text
server/
  index.js
  config.js
  compute/motion_state.js
  router/message_router.js
  shared/schema.js
  session/
    session_manager.js
    recorders/
      imu_recorder.js
      camera_recorder.js
      events_recorder.js
      net_recorder.js
public/
  phone.html
  phone.js
  dashboard.html
  dashboard.js
  styles.css
sessions/
```

## Prerequisites

- Windows with Node.js installed.
- HTTPS certificate + key files (recommended: `mkcert`).
- FFmpeg installed and available as `ffmpeg` in PATH for camera `video/both` encoding.
- iPhone and laptop on the same LAN/hotspot.

## Install

From project root:

```powershell
npm install
```

If PowerShell blocks `npm` or PATH is not set:

```powershell
& "C:\Program Files\nodejs\npm.cmd" install
```

## Run

```powershell
node server\index.js --cert certs\cert.pem --key certs\key.pem --port 8443
```

If `node` is not in PATH:

```powershell
& "C:\Program Files\nodejs\node.exe" server\index.js --cert certs\cert.pem --key certs\key.pem --port 8443
```

## Open

- Dashboard on laptop: `https://localhost:8443/dashboard`
- Phone page: `https://<laptop-ip>:8443/phone`
- Optional explicit device ID: `https://<laptop-ip>:8443/phone?device_id=iphone-AB12`
- WebSocket endpoint: `wss://<host>:8443/ws`

Use your real hotspot/Wi-Fi IPv4 address for `<laptop-ip>` (not virtual adapter IPs).

## Recording Output

On recording start:

```text
sessions/session_YYYYMMDD_HHMMSS/
  meta.json
  control_log.jsonl
  devices/
    <device_id>/
      streams/
        imu.csv                  (only if imu.record=true)
        audio.csv                (only if audio.record=true)
        audio.wav                (raw mic PCM wrapped as WAV, only if audio.record=true)
        device.csv               (only if device.record=true)
        fusion.csv               (only if fusion.record=true)
        events.csv               (only if events.record=true)
        net.csv                  (only if net.record=true)
        camera/                  (only if camera.record=true AND camera.mode=stream)
          000001.jpg
        camera_timestamps.csv    (with camera jpg stream)
        camera_video.mp4         (if camera.record_mode is video or both and FFmpeg succeeds)
```

### `meta.json` includes
- `device_id`
- `start_time_iso`
- `runConfig` snapshot
- `laptop_ip`
- phone metadata (`user_agent` when available)

### `control_log.jsonl` includes
- recording start/stop
- config updates (`set_config`)

## Multi-Phone Audio WAV Recording

To record microphone WAV from multiple phones at once:

1. Connect each phone to `/phone` with a unique `device_id`.
2. For each device in dashboard:
   - set `Audio enabled = true`
   - set `Audio record = true`
3. Click `Start Recording (All Devices)`.
4. Stop recording when done.

You will get one WAV file per device:

```text
sessions/session_.../devices/<device_id>/streams/audio.wav
```

Notes:
- WAV is mono PCM16 from phone microphone.
- WAV is written only while recording is active and audio recording is enabled for that device.

## Quick Camera Validation

1. Open `/phone`, tap **Start** (grant permissions).
2. In dashboard set camera mode to `preview` and confirm phone preview is live.
3. Switch to `stream` and confirm dashboard camera image updates and Camera FPS > 0.
4. Enable `camera.record`, start recording, then stop and check `sessions/.../streams/camera`.

If using camera `record_mode=video` or `both`, also confirm:
- `sessions/.../streams/camera_video.mp4` is created after stop.
- If missing, set FFmpeg path before run:
  - PowerShell: `$env:FFMPEG_BIN = "C:\path\to\ffmpeg.exe"`

## Privacy Notes

- No cloud upload. Data stays on local laptop storage.
- Camera can be disabled entirely or used in preview-only mode.

## Troubleshooting

- `node`/`npm` not recognized:
  - Use full executable paths in commands above.
  - Optionally add `C:\Program Files\nodejs\` to PATH.
- iPhone cannot connect:
  - Confirm same LAN/hotspot.
  - Use correct adapter IPv4 from `ipconfig`.
  - Allow port `8443` in Windows firewall.
- Browser says certificate is unsafe:
  - Expected with self-signed cert.
  - For best iPhone reliability, use a trusted local cert (mkcert).
- Video file not generated:
  - Verify FFmpeg is installed: `ffmpeg -version`
  - Set `FFMPEG_BIN` env var if FFmpeg is not in PATH.
  - If camera encode timing is `manual`, use the dashboard `Encode Video` button in Replay section.
- Recording start blocked:
  - If storage policy is `on_quota_exceeded=block` and quota is exceeded, dashboard shows a block message.
  - Reduce session size, delete old sessions, or switch policy to `delete_oldest`.
