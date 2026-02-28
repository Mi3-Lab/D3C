const fs = require("fs");
const path = require("path");
const https = require("https");
const os = require("os");
const express = require("express");
const { WebSocketServer, WebSocket } = require("ws");
const { DEFAULT_RUN_CONFIG, STATE_BROADCAST_HZ, DATASETS_ROOT } = require("./config");
const { sanitizeRunConfig, WS_ROLES } = require("./shared/schema");
const { MotionState } = require("./compute/motion_state");
const { SessionManager } = require("./session/session_manager");

const args = parseArgs(process.argv.slice(2));
if (!args.cert || !args.key) {
  console.error("Usage: node fleet-server/index.js --cert cert.pem --key key.pem --port 8443");
  process.exit(1);
}

const app = express();
app.use(express.static(path.join(process.cwd(), "client-mobile")));
app.use(express.static(path.join(process.cwd(), "dashboard")));
app.use("/datasets", express.static(DATASETS_ROOT));
app.use("/sessions", express.static(DATASETS_ROOT));
app.get("/phone", (_req, res) => res.sendFile(path.join(process.cwd(), "client-mobile", "phone.html")));
app.get("/dashboard", (_req, res) => res.sendFile(path.join(process.cwd(), "dashboard", "dashboard.html")));
app.get("/latest.jpg", (req, res) => {
  const deviceId = typeof req.query.device_id === "string" ? req.query.device_id : focusedDeviceId;
  if (!deviceId || !devices.has(deviceId)) return res.status(404).send("No frame");
  const d = devices.get(deviceId);
  if (!d.latestCameraBuffer) return res.status(404).send("No frame");
  res.setHeader("Content-Type", d.latestCameraMime || "image/jpeg");
  res.setHeader("Cache-Control", "no-store");
  res.send(d.latestCameraBuffer);
});

// Legacy API compatibility: redirect old sessions endpoints to datasets endpoints.
app.all("/api/sessions*", (req, res) => {
  const target = req.originalUrl.replace(/^\/api\/sessions/, "/api/datasets");
  res.redirect(307, target);
});

app.get("/api/datasets", (_req, res) => {
  try {
    if (!fs.existsSync(DATASETS_ROOT)) return res.json({ sessions: [] });
    const sessions = fs.readdirSync(DATASETS_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith("session_"))
      .map((d) => d.name)
      .sort()
      .reverse();
    res.json({ sessions });
  } catch {
    res.status(500).json({ sessions: [] });
  }
});
app.get("/api/storage", (_req, res) => {
  try {
    const sessionsSize = dirSizeBytes(DATASETS_ROOT);
    const freeBytes = getDiskFreeBytes(process.cwd());
    const sessionCount = fs.existsSync(DATASETS_ROOT)
      ? fs.readdirSync(DATASETS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith("session_")).length
      : 0;
    res.json({
      sessions_size_bytes: sessionsSize,
      sessions_size_gb: Number((sessionsSize / (1024 ** 3)).toFixed(3)),
      free_disk_bytes: freeBytes,
      session_count: sessionCount
    });
  } catch {
    res.status(500).json({ error: "storage query failed" });
  }
});
app.post("/api/datasets/:id/encode", express.json(), async (req, res) => {
  const id = sanitizeSessionId(req.params.id);
  if (!id) return res.status(400).json({ error: "invalid id" });
  const root = path.join(DATASETS_ROOT, id);
  const deviceId = String(req.body?.device_id || "").trim();
  if (!deviceId) return res.status(400).json({ error: "device_id required" });
  const streamsDir = path.join(root, "devices", deviceId, "streams");
  const cameraDir = path.join(streamsDir, "camera");
  if (!fs.existsSync(cameraDir)) return res.status(404).json({ error: "camera frames not found" });
  const outMp4 = path.join(streamsDir, "camera_video.mp4");
  const fps = Math.max(1, Number(req.body?.fps || 10));
  const bitrate = String(req.body?.bitrate || "2M");
  const crf = Number.isFinite(req.body?.crf) ? Number(req.body.crf) : 23;
  const ffmpeg = process.env.FFMPEG_BIN || "ffmpeg";
  const result = await encodeCameraDirToMp4({ cameraDir, outMp4, fps, bitrate, crf, ffmpegBin: ffmpeg });
  const logPath = path.join(root, "control_log.jsonl");
  appendControlLog(logPath, { type: "manual_encode", device_id: deviceId, at_iso: new Date().toISOString(), result });
  if (!result.ok) return res.status(500).json(result);
  res.json(result);
});
app.delete("/api/datasets/:id", (req, res) => {
  const id = sanitizeSessionId(req.params.id);
  if (!id) return res.status(400).json({ error: "invalid id" });
  const root = path.join(DATASETS_ROOT, id);
  if (!fs.existsSync(root)) return res.status(404).json({ error: "not found" });
  try {
    fs.rmSync(root, { recursive: true, force: true });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

app.get("/api/datasets/:id/manifest", (req, res) => {
  const id = sanitizeSessionId(req.params.id);
  if (!id) return res.status(400).json({ error: "invalid id" });
  const root = path.join(DATASETS_ROOT, id);
  if (!fs.existsSync(root)) return res.status(404).json({ error: "not found" });
  const requested = typeof req.query.device_id === "string" ? req.query.device_id : null;
  const deviceId = requested && fs.existsSync(path.join(root, "devices", requested))
    ? requested
    : firstDeviceId(root);
  if (!deviceId) return res.status(404).json({ error: "no devices in session" });
  const streamRoot = path.join(root, "devices", deviceId, "streams");
  res.json({
    id,
    device_id: deviceId,
    metaJson: toUrlIfExists(path.join(root, "meta.json"), `/datasets/${id}/meta.json`),
    imuCsv: toUrlIfExists(path.join(streamRoot, "imu.csv"), `/datasets/${id}/devices/${deviceId}/streams/imu.csv`),
    audioCsv: toUrlIfExists(path.join(streamRoot, "audio.csv"), `/datasets/${id}/devices/${deviceId}/streams/audio.csv`),
    audioWav: toUrlIfExists(path.join(streamRoot, "audio.wav"), `/datasets/${id}/devices/${deviceId}/streams/audio.wav`),
    deviceCsv: toUrlIfExists(path.join(streamRoot, "device.csv"), `/datasets/${id}/devices/${deviceId}/streams/device.csv`),
    fusionCsv: toUrlIfExists(path.join(streamRoot, "fusion.csv"), `/datasets/${id}/devices/${deviceId}/streams/fusion.csv`),
    eventsCsv: toUrlIfExists(path.join(streamRoot, "events.csv"), `/datasets/${id}/devices/${deviceId}/streams/events.csv`),
    netCsv: toUrlIfExists(path.join(streamRoot, "net.csv"), `/datasets/${id}/devices/${deviceId}/streams/net.csv`),
    gpsCsv: toUrlIfExists(path.join(streamRoot, "gps.csv"), `/datasets/${id}/devices/${deviceId}/streams/gps.csv`),
    cameraTimestampsCsv: toUrlIfExists(
      path.join(streamRoot, "camera_timestamps.csv"),
      `/datasets/${id}/devices/${deviceId}/streams/camera_timestamps.csv`
    ),
    cameraVideo: toUrlIfExists(
      path.join(streamRoot, "camera_video.mp4"),
      `/datasets/${id}/devices/${deviceId}/streams/camera_video.mp4`
    ),
    cameraDir: toUrlIfExists(path.join(streamRoot, "camera"), `/datasets/${id}/devices/${deviceId}/streams/camera`)
  });
});

const server = https.createServer(
  { cert: fs.readFileSync(args.cert), key: fs.readFileSync(args.key) },
  app
);
const wss = new WebSocketServer({ server, path: "/ws" });
const sessionManager = new SessionManager();

const devices = new Map(); // device_id -> device entry
const dashboardSockets = new Set();
const pendingCameraHeaderBySocket = new Map(); // ws -> header
const pendingPingsByDevice = new Map(); // device_id -> ping map

let focusedDeviceId = null;
const recording = {
  active: false,
  mode: "focused",
  session_dir: null,
  started_at_ms: null
};

wss.on("connection", (ws) => {
  console.log("[ws] socket connected");
  ws.role = null;
  ws.device_id = null;

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      if (ws.role === "phone") handlePhoneBinary(ws, data);
      return;
    }
    let msg = null;
    try { msg = JSON.parse(data.toString("utf8")); } catch { return; }
    if (!msg) return;

    if (msg.type === "hello") {
      console.log("[ws] hello", { role: msg.role, device_id: msg.device_id || null });
      handleHello(ws, msg);
      return;
    }
    if (ws.role === "phone") handlePhoneJson(ws, msg);
    if (ws.role === "dashboard") handleDashboardJson(ws, msg);
  });

  ws.on("close", () => {
    console.log("[ws] socket closed", { role: ws.role, device_id: ws.device_id });
    pendingCameraHeaderBySocket.delete(ws);
    if (ws.role === "phone") {
      const d = devices.get(ws.device_id);
      if (d && d.ws === ws) {
        d.connected = false;
        d.ws = null;
        d.lastSeenTs = Date.now();
      }
      if (focusedDeviceId === ws.device_id) {
        focusedDeviceId = firstConnectedDeviceId() || null;
      }
      broadcastDeviceList();
    }
    dashboardSockets.delete(ws);
  });
});

setInterval(() => {
  for (const [id, d] of devices.entries()) {
    const expectedImu = d.config.streams.imu.enabled ? d.config.streams.imu.rate_hz : 0;
    const expectedCam = d.config.streams.camera.mode === "stream" ? d.config.streams.camera.fps : 0;
    d.stats.imu_hz = d.stats.imu_count;
    d.stats.camera_fps = d.stats.camera_count;
    d.stats.dropped_frames = Math.max(0, Math.round(expectedCam - d.stats.camera_count));
    d.stats.dropped_packets = Math.max(0, Math.round(expectedImu - d.stats.imu_count)) + d.stats.dropped_frames;
    d.stats.imu_count = 0;
    d.stats.camera_count = 0;
    d.connectionStatus = classifyConnection({
      connected: d.connected,
      rttMs: d.stats.rtt_ms,
      droppedPackets: d.stats.dropped_packets,
      lastSeenMs: d.lastSeenTs
    });
    if (recording.active && sessionManager.shouldRecordDevice(id)) {
      sessionManager.writeNet(id, {
        t_recv_ms: Date.now(),
        fps: d.stats.camera_fps,
        dropped_frames: d.stats.dropped_frames,
        rtt_ms: d.stats.rtt_ms ?? -1
      });
      const fusion = computeFusion(d);
      d.state.fusion = fusion;
      sessionManager.writeFusion(id, {
        t_recv_ms: Date.now(),
        connection_quality: fusion.connection_quality,
        sensing_confidence: fusion.sensing_confidence
      });
    }
  }
  broadcastState();
  broadcastDeviceList();
}, 1000);

setInterval(() => {
  for (const [deviceId, d] of devices.entries()) {
    if (!d.connected || !d.ws || d.ws.readyState !== WebSocket.OPEN) continue;
    const ping_id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    pendingPingsByDevice.get(deviceId).set(ping_id, Date.now());
    sendWs(d.ws, { type: "ping", ping_id, t_sent_ms: Date.now() }, { critical: true });
  }
}, 2000);

const stateIntervalMs = Math.round(1000 / STATE_BROADCAST_HZ);
setInterval(() => broadcastState(), stateIntervalMs);

server.listen(args.port, "0.0.0.0", () => {
  console.log(`D3C Fleet Server listening on https://0.0.0.0:${args.port}`);
  console.log(`Dashboard: https://localhost:${args.port}/dashboard`);
  console.log(`Phone: https://<laptop-ip>:${args.port}/phone`);
});

function handleHello(ws, msg) {
  if (!WS_ROLES.includes(msg.role)) return;
  ws.role = msg.role;
  if (ws.role === "dashboard") {
    console.log("[ws] dashboard registered");
    dashboardSockets.add(ws);
    sendWs(ws, { type: "device_list", devices: deviceSummaries() });
    sendWs(ws, { type: "focus", focused_device_id: focusedDeviceId });
    if (focusedDeviceId && devices.has(focusedDeviceId)) {
      sendWs(ws, { type: "config", device_id: focusedDeviceId, runConfig: devices.get(focusedDeviceId).config });
    }
    return;
  }

  const requested = String(msg.device_id || "").trim() || `iphone-${Math.random().toString(36).slice(2, 6)}`;
  const unique = uniqueDeviceId(requested);
  ws.device_id = unique;
  const existing = devices.get(unique) || newDeviceEntry(unique);
  existing.ws = ws;
  existing.connected = true;
  existing.connectedAt = Date.now();
  existing.lastSeenTs = Date.now();
  existing.user_agent = msg.user_agent || null;
  devices.set(unique, existing);
  if (!pendingPingsByDevice.has(unique)) pendingPingsByDevice.set(unique, new Map());
  if (!focusedDeviceId) focusedDeviceId = unique;

  sendWs(ws, {
    type: "hello_ack",
    device_id: unique,
    renamed_from: unique !== requested ? requested : null
  });
  console.log("[ws] phone registered", { requested, assigned: unique });
  sendWs(ws, { type: "config", device_id: unique, runConfig: existing.config });
  broadcastDeviceList();
  broadcastState();
}

function handlePhoneJson(ws, msg) {
  const deviceId = ws.device_id;
  const d = devices.get(deviceId);
  if (!d) return;
  d.lastSeenTs = Date.now();
  if (msg.type === "imu") {
    if (!allowByRate(d, "imu", d.config.streams.imu.rate_hz)) return;
    const ax = Number(msg.accel_mps2?.[0] || 0);
    const ay = Number(msg.accel_mps2?.[1] || 0);
    const az = Number(msg.accel_mps2?.[2] || 0);
    const gx = Number(msg.gyro_rads?.[0] || 0);
    const gy = Number(msg.gyro_rads?.[1] || 0);
    const gz = Number(msg.gyro_rads?.[2] || 0);
    const tRecvMs = Date.now();
    const mag = Math.sqrt(ax * ax + ay * ay + az * az);
    const motion = d.motion.update(ax, ay, az);
    if (motion.motion_state === "STILL") {
      d.stillSinceMs ||= tRecvMs;
    } else {
      d.stillSinceMs = null;
    }
    d.state.motion_state = motion.motion_state;
    d.state.motion_conf = motion.confidence;
    d.state.inactivity_duration_sec = d.stillSinceMs ? Number(((tRecvMs - d.stillSinceMs) / 1000).toFixed(1)) : 0;
    d.state.imu_latest = {
      t_recv_ms: tRecvMs,
      t_device_ms: Number(msg.t_device_ms || 0),
      accel_mps2: [ax, ay, az],
      gyro_rads: [gx, gy, gz],
      mag
    };
    d.stats.imu_count += 1;
    if (recording.active) {
      sessionManager.writeImu(deviceId, {
        t_recv_ms: tRecvMs,
        t_device_ms: Number(msg.t_device_ms || 0),
        ax, ay, az, gx, gy, gz
      });
    }
    return;
  }
  if (msg.type === "camera_header") {
    if (!allowByRate(d, "camera", d.config.streams.camera.fps || 10)) return;
    pendingCameraHeaderBySocket.set(ws, {
      device_id: deviceId,
      t_device_ms: Number(msg.t_device_ms || 0),
      format: msg.format || "jpeg",
      lighting_score: Number.isFinite(msg.lighting_score) ? Number(msg.lighting_score) : null
    });
    return;
  }
  if (msg.type === "audio") {
    if (!allowByRate(d, "audio", d.config.streams.audio.rate_hz || 10)) return;
    const tRecvMs = Date.now();
    d.state.audio_latest = {
      t_recv_ms: tRecvMs,
      t_device_ms: Number(msg.t_device_ms || 0),
      amplitude: Number(msg.amplitude || 0),
      noise_level: Number(msg.noise_level || 0)
    };
    if (recording.active) {
      sessionManager.writeAudio(deviceId, {
        t_recv_ms: tRecvMs,
        t_device_ms: Number(msg.t_device_ms || 0),
        amplitude: Number(msg.amplitude || 0),
        noise_level: Number(msg.noise_level || 0)
      });
    }
    return;
  }
  if (msg.type === "gps") {
    if (!allowByRate(d, "gps", d.config.streams.gps.rate_hz || 1)) return;
    const tRecvMs = Date.now();
    const lat = Number(msg.lat || 0);
    const lon = Number(msg.lon || 0);
    const accuracy_m = Number(msg.accuracy_m || -1);
    const speed_mps = Number(msg.speed_mps || -1);
    const heading_deg = Number(msg.heading_deg || -1);
    const altitude_m = Number(msg.altitude_m || -1);
    d.state.gps_latest = {
      t_recv_ms: tRecvMs,
      t_device_ms: Number(msg.t_device_ms || 0),
      lat, lon, accuracy_m, speed_mps, heading_deg, altitude_m
    };
    if (recording.active) {
      sessionManager.writeGps(deviceId, {
        t_recv_ms: tRecvMs,
        t_device_ms: Number(msg.t_device_ms || 0),
        lat, lon, accuracy_m, speed_mps, heading_deg, altitude_m
      });
    }
    return;
  }
  if (msg.type === "audio_pcm") {
    if (!d.config.streams.audio.enabled) return;
    if (!recording.active) return;
    if (!d.config.streams.audio.record) return;
    const b64 = typeof msg.data_b64 === "string" ? msg.data_b64 : "";
    if (!b64) return;
    let pcmBuffer = null;
    try {
      pcmBuffer = Buffer.from(b64, "base64");
    } catch {
      return;
    }
    if (!pcmBuffer.length) return;
    sessionManager.writeAudioPcm(deviceId, {
      pcmBuffer,
      t_recv_ms: Date.now(),
      t_device_ms: Number(msg.t_device_ms || 0),
      sampleRate: Number(msg.sample_rate || 48000),
      channels: Number(msg.channels || 1),
      bitsPerSample: 16
    });
    return;
  }
  if (msg.type === "device") {
    if (!allowByRate(d, "device", d.config.streams.device.rate_hz || 1)) return;
    const tRecvMs = Date.now();
    d.state.device_latest = {
      t_recv_ms: tRecvMs,
      t_device_ms: Number(msg.t_device_ms || 0),
      battery_level: Number(msg.battery_level ?? -1),
      charging: !!msg.charging,
      orientation: String(msg.orientation || "unknown")
    };
    if (recording.active) {
      sessionManager.writeDevice(deviceId, {
        t_recv_ms: tRecvMs,
        t_device_ms: Number(msg.t_device_ms || 0),
        battery_level: Number(msg.battery_level ?? -1),
        charging: !!msg.charging,
        orientation: String(msg.orientation || "unknown")
      });
    }
    return;
  }
  if (msg.type === "heartbeat") {
    d.lastSeenTs = Date.now();
    return;
  }
  if (msg.type === "event") {
    const tRecvMs = Date.now();
    const entry = { t_recv_ms: tRecvMs, label: String(msg.label || ""), source: "phone", device_id: deviceId };
    d.state.event_timeline.push(entry);
    if (d.state.event_timeline.length > 50) d.state.event_timeline.shift();
    if (recording.active) {
      sessionManager.writeEvent(deviceId, {
        t_recv_ms: tRecvMs,
        t_device_ms: Number(msg.t_device_ms || 0),
        label: entry.label,
        meta: { source: "phone" }
      });
    }
    return;
  }
  if (msg.type === "pong") {
    const pingMap = pendingPingsByDevice.get(deviceId);
    const sent = pingMap?.get(String(msg.ping_id || ""));
    if (!sent) return;
    d.stats.rtt_ms = Date.now() - sent;
    pingMap.delete(String(msg.ping_id || ""));
  }
}

function handlePhoneBinary(ws, data) {
  const d = devices.get(ws.device_id);
  if (!d) return;
  const header = pendingCameraHeaderBySocket.get(ws);
  if (!header) return;
  pendingCameraHeaderBySocket.delete(ws);
  const tRecvMs = Date.now();
  d.latestCameraBuffer = Buffer.from(data);
  d.latestCameraMime = header.format === "jpeg" ? "image/jpeg" : "application/octet-stream";
  d.state.camera_latest_ts = tRecvMs;
  if (Number.isFinite(header.lighting_score)) d.state.camera_quality.lighting_score = header.lighting_score;
  d.stats.camera_count += 1;
  if (recording.active) {
    sessionManager.writeCamera(ws.device_id, {
      jpegBuffer: d.latestCameraBuffer,
      t_device_ms: header.t_device_ms,
      t_recv_ms: tRecvMs
    });
  }
}

function handleDashboardJson(ws, msg) {
  if (msg.type === "set_focus") {
    const id = String(msg.device_id || "");
    if (devices.has(id)) focusedDeviceId = id;
    sendWs(ws, { type: "focus", focused_device_id: focusedDeviceId });
    if (focusedDeviceId) sendWs(ws, { type: "config", device_id: focusedDeviceId, runConfig: devices.get(focusedDeviceId).config });
    broadcastState();
    return;
  }
  if (msg.type === "set_config") {
    const target = String(msg.device_id || focusedDeviceId || "");
    if (!target || !devices.has(target)) return;
    const d = devices.get(target);
    d.config = sanitizeRunConfig(msg.runConfig, d.config);
    sessionManager.updateDeviceConfig(target, d.config);
    sendWs(d.ws, { type: "config", device_id: target, runConfig: d.config });
    broadcastToDashboards({ type: "config", device_id: target, runConfig: d.config });
    broadcastState();
    return;
  }
  if (msg.type === "recording") {
    if (msg.action === "start") {
      if (DEFAULT_RUN_CONFIG.storage?.auto_cleanup) {
        const cleanup = runStorageCleanupPolicy(DEFAULT_RUN_CONFIG.storage);
        if (cleanup.blocked) {
          broadcastToDashboards({
            type: "recording_error",
            error: "storage_quota_exceeded",
            details: cleanup
          });
          return;
        }
      }
      const mode = msg.scope === "all" ? "all" : "focused";
      const connectedEntries = [...devices.entries()].filter(([, d]) => d.connected);
      const deviceConfigs = new Map(
        (mode === "all" ? connectedEntries : connectedEntries.filter(([id]) => id === focusedDeviceId))
          .map(([id, d]) => [id, d.config])
      );
      const deviceDetails = Object.fromEntries(
        (mode === "all" ? connectedEntries : connectedEntries.filter(([id]) => id === focusedDeviceId))
          .map(([id, d]) => [id, {
            user_agent: d.user_agent || null,
            connected_at_ms: d.connectedAt || null,
            last_seen_ms: d.lastSeenTs || null
          }])
      );
      if (!deviceConfigs.size) return;
      const res = sessionManager.start({
        mode,
        focusedDeviceId: focusedDeviceId || null,
        devicesConfigMap: deviceConfigs,
        extraMeta: { laptop_ip: getPrimaryLanIp(), device_details: deviceDetails }
      });
      recording.active = true;
      recording.mode = mode;
      recording.session_dir = res.sessionDir;
      recording.started_at_ms = Date.now();
      broadcastState();
    } else if (msg.action === "stop") {
      const res = sessionManager.stop();
      recording.active = false;
      recording.session_dir = res.sessionDir;
      recording.started_at_ms = null;
      broadcastState();
    }
    return;
  }
  if (msg.type === "event") {
    const deviceId = String(msg.device_id || focusedDeviceId || "");
    if (!deviceId || !devices.has(deviceId)) return;
    const d = devices.get(deviceId);
    const tRecvMs = Date.now();
    const entry = { t_recv_ms: tRecvMs, label: String(msg.label || ""), source: "dashboard", device_id: deviceId };
    d.state.event_timeline.push(entry);
    if (d.state.event_timeline.length > 50) d.state.event_timeline.shift();
    if (recording.active) {
      sessionManager.writeEvent(deviceId, {
        t_recv_ms: tRecvMs,
        t_device_ms: 0,
        label: entry.label,
        meta: { source: "dashboard" }
      });
    }
  }
}

function broadcastState() {
  const focused = focusedDeviceId ? devices.get(focusedDeviceId) : null;
  const payload = {
    type: "state",
    focused_device_id: focusedDeviceId,
    focused: focused ? publicStateForDevice(focusedDeviceId, focused) : null,
    devices: deviceSummaries(),
    recording: {
      active: recording.active,
      mode: recording.mode,
      session_dir: recording.session_dir,
      elapsed_sec: recording.started_at_ms ? Math.max(0, Math.round((Date.now() - recording.started_at_ms) / 1000)) : 0
    }
  };
  broadcastToDashboards(payload);
}

function broadcastDeviceList() {
  broadcastToDashboards({ type: "device_list", devices: deviceSummaries() });
}

function publicStateForDevice(deviceId, d) {
  return {
    device_id: deviceId,
    connected: d.connected,
    motion_state: d.state.motion_state,
    motion_conf: d.state.motion_conf,
    inactivity_duration_sec: d.state.inactivity_duration_sec,
    imu_latest: d.state.imu_latest,
    camera_latest_ts: d.state.camera_latest_ts,
    audio_latest: d.state.audio_latest,
    gps_latest: d.state.gps_latest,
    device_latest: d.state.device_latest,
    camera_quality: d.state.camera_quality,
    fusion: d.state.fusion,
    net: {
      imu_hz: d.stats.imu_hz,
      camera_fps: d.stats.camera_fps,
      dropped_frames: d.stats.dropped_frames,
      dropped_packets: d.stats.dropped_packets,
      rtt_ms: d.stats.rtt_ms
    },
    event_timeline: d.state.event_timeline,
    stream_status: buildStreamStatus(d.config, d)
  };
}

function deviceSummaries() {
  const out = [];
  for (const [id, d] of devices.entries()) {
    out.push({
      device_id: id,
      connected: !!d.connected,
      lastSeenTs: d.lastSeenTs,
      motion_state: d.state.motion_state,
      imuHz: d.stats.imu_hz,
      camFps: d.stats.camera_fps,
      rttMs: d.stats.rtt_ms,
      connectionStatus: d.connectionStatus || "disconnected",
      recordingActive: recording.active && sessionManager.shouldRecordDevice(id)
    });
  }
  return out.sort((a, b) => a.device_id.localeCompare(b.device_id));
}

function buildStreamStatus(config, d) {
  const s = config.streams;
  const now = Date.now();
  return {
    imu: { enabled: !!s.imu.enabled, recording: !!s.imu.record, rate: `${s.imu.rate_hz} Hz`, last_seen_ms: d.state.imu_latest?.t_recv_ms || null },
    camera: {
      enabled: s.camera.mode !== "off",
      recording: !!s.camera.record && s.camera.mode === "stream",
      rate: s.camera.mode === "stream" ? `${s.camera.fps} fps (${s.camera.record_mode || "jpg"})` : s.camera.mode,
      last_seen_ms: d.state.camera_latest_ts || null
    },
    gps: { enabled: !!s.gps.enabled, recording: !!s.gps.record, rate: `${s.gps.rate_hz} Hz`, last_seen_ms: d.state.gps_latest?.t_recv_ms || null },
    audio: { enabled: !!s.audio.enabled, recording: !!s.audio.record, rate: `${s.audio.rate_hz} Hz`, last_seen_ms: d.state.audio_latest?.t_recv_ms || null },
    device: { enabled: !!s.device.enabled, recording: !!s.device.record, rate: `${s.device.rate_hz} Hz`, last_seen_ms: d.state.device_latest?.t_recv_ms || null },
    fusion: { enabled: !!s.fusion.enabled, recording: !!s.fusion.record, rate: "-", last_seen_ms: now },
    events: {
      enabled: true,
      recording: !!s.events.record,
      rate: "-",
      last_seen_ms: d.state.event_timeline.length ? d.state.event_timeline[d.state.event_timeline.length - 1].t_recv_ms : null
    },
    net: { enabled: !!s.net.enabled, recording: !!s.net.record, rate: "-", last_seen_ms: d.stats.rtt_ms != null ? now : null }
  };
}

function computeFusion(d) {
  const rttScore = d.stats.rtt_ms == null ? 0.6 : Math.max(0, 1 - Math.min(1, d.stats.rtt_ms / 300));
  const dropScore = Math.max(0, 1 - Math.min(1, d.stats.dropped_packets / 20));
  const connection_quality = Number((0.6 * rttScore + 0.4 * dropScore).toFixed(3));
  const enabled = [];
  if (d.config.streams.imu.enabled) enabled.push(d.state.imu_latest?.t_recv_ms || 0);
  if (d.config.streams.camera.mode === "stream") enabled.push(d.state.camera_latest_ts || 0);
  if (d.config.streams.audio.enabled) enabled.push(d.state.audio_latest?.t_recv_ms || 0);
  if (d.config.streams.device.enabled) enabled.push(d.state.device_latest?.t_recv_ms || 0);
  const now = Date.now();
  let fresh = 0;
  for (const ts of enabled) if (ts && now - ts < 4000) fresh += 1;
  const sensing_confidence = enabled.length ? Number((fresh / enabled.length).toFixed(3)) : 0;
  return { connection_quality, sensing_confidence };
}

function uniqueDeviceId(requested) {
  if (!devices.has(requested) || !devices.get(requested).connected) return requested;
  let n = 2;
  while (true) {
    const cand = `${requested}-${n}`;
    if (!devices.has(cand) || !devices.get(cand).connected) return cand;
    n += 1;
  }
}

function newDeviceEntry(deviceId) {
  return {
    ws: null,
    connected: false,
    connectedAt: null,
    lastSeenTs: null,
    user_agent: null,
    config: clone(DEFAULT_RUN_CONFIG),
    motion: new MotionState(60),
    stillSinceMs: null,
    latestCameraBuffer: null,
    latestCameraMime: "image/jpeg",
    state: {
      motion_state: "UNKNOWN",
      motion_conf: 0,
      inactivity_duration_sec: 0,
      imu_latest: null,
      camera_latest_ts: null,
      audio_latest: null,
      gps_latest: null,
      device_latest: null,
      camera_quality: { lighting_score: null },
      fusion: { connection_quality: 0, sensing_confidence: 0 },
      event_timeline: []
    },
    stats: {
      imu_count: 0,
      camera_count: 0,
      imu_hz: 0,
      camera_fps: 0,
      dropped_frames: 0,
      dropped_packets: 0,
      rtt_ms: null
    },
    lastGateMs: {},
    connectionStatus: "disconnected"
  };
}

function firstConnectedDeviceId() {
  for (const [id, d] of devices.entries()) if (d.connected) return id;
  return null;
}

function sendWs(ws, payload, opts = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const maxBufferedBytes = (DEFAULT_RUN_CONFIG.performance?.max_ws_buffer_kb || 1024) * 1024;
  if (!opts.critical && ws.bufferedAmount > maxBufferedBytes) return;
  ws.send(JSON.stringify(payload));
}

function broadcastToDashboards(payload) {
  const text = JSON.stringify(payload);
  const maxBufferedBytes = (DEFAULT_RUN_CONFIG.performance?.max_ws_buffer_kb || 1024) * 1024;
  for (const ws of dashboardSockets) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (ws.bufferedAmount > maxBufferedBytes) continue;
    ws.send(text);
  }
}

function parseArgs(argv) {
  const out = { port: 8443, cert: null, key: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i] || 8443);
    else if (a === "--cert") out.cert = argv[++i] || null;
    else if (a === "--key") out.key = argv[++i] || null;
  }
  return out;
}

function getPrimaryLanIp() {
  const nets = os.networkInterfaces();
  for (const key of Object.keys(nets)) {
    for (const ni of nets[key] || []) {
      if (ni.family === "IPv4" && !ni.internal) return ni.address;
    }
  }
  return null;
}

function sanitizeSessionId(raw) {
  if (typeof raw !== "string") return null;
  if (!/^session_[A-Za-z0-9_]+$/.test(raw)) return null;
  return raw;
}

function toUrlIfExists(absPath, urlPath) {
  if (!fs.existsSync(absPath)) return null;
  return urlPath;
}

function firstDeviceId(sessionRoot) {
  const dir = path.join(sessionRoot, "devices");
  if (!fs.existsSync(dir)) return null;
  const ids = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  return ids[0] || null;
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function allowByRate(deviceEntry, streamKey, targetHz) {
  const hz = Math.max(1, Number(targetHz || 1));
  const minInterval = Math.floor(1000 / hz);
  const now = Date.now();
  const last = deviceEntry.lastGateMs[streamKey] || 0;
  if (now - last < minInterval) return false;
  deviceEntry.lastGateMs[streamKey] = now;
  return true;
}

function classifyConnection({ connected, rttMs, droppedPackets, lastSeenMs }) {
  if (!connected) return "disconnected";
  const age = Date.now() - Number(lastSeenMs || 0);
  if (age > 5000) return "degraded";
  const rtt = Number(rttMs || 0);
  const dropped = Number(droppedPackets || 0);
  if (rtt < 100 && dropped < 1) return "excellent";
  if (rtt < 250 && dropped < 5) return "good";
  return "poor";
}

function dirSizeBytes(root) {
  try {
    if (!fs.existsSync(root)) return 0;
    let total = 0;
    const walk = (p) => {
      const entries = fs.readdirSync(p, { withFileTypes: true });
      for (const e of entries) {
        const abs = path.join(p, e.name);
        if (e.isDirectory()) walk(abs);
        else total += fs.statSync(abs).size;
      }
    };
    walk(root);
    return total;
  } catch {
    return 0;
  }
}

function runStorageCleanupPolicy(storageCfg) {
  if (!fs.existsSync(DATASETS_ROOT)) return { blocked: false };
  const sessions = fs.readdirSync(DATASETS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("session_"))
    .map((d) => ({ name: d.name, abs: path.join(DATASETS_ROOT, d.name), mtime: fs.statSync(path.join(DATASETS_ROOT, d.name)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);

  const maxAgeMs = Number(storageCfg.max_session_age_days || 30) * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let deletedByAge = 0;
  for (const s of sessions) {
    if (now - s.mtime <= maxAgeMs) continue;
    try {
      fs.rmSync(s.abs, { recursive: true, force: true });
      deletedByAge += 1;
    } catch {}
  }

  const keepMin = Math.max(0, Number(storageCfg.keep_minimum_sessions || 10));
  const maxBytes = Number(storageCfg.max_total_size_gb || 50) * 1024 * 1024 * 1024;
  let currentSize = dirSizeBytes(DATASETS_ROOT);
  const policy = storageCfg.on_quota_exceeded || "warn";
  if (currentSize <= maxBytes) {
    return { blocked: false, deletedByAge, deletedByQuota: 0, currentSize };
  }
  if (policy === "block") {
    return { blocked: true, deletedByAge, deletedByQuota: 0, currentSize, maxBytes };
  }
  if (policy !== "delete_oldest") {
    return { blocked: false, deletedByAge, deletedByQuota: 0, currentSize, maxBytes };
  }

  const latest = fs.readdirSync(DATASETS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("session_"))
    .map((d) => ({ name: d.name, abs: path.join(DATASETS_ROOT, d.name), mtime: fs.statSync(path.join(DATASETS_ROOT, d.name)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);

  let deletedByQuota = 0;
  while (currentSize > maxBytes && latest.length > keepMin) {
    const oldest = latest.shift();
    try {
      fs.rmSync(oldest.abs, { recursive: true, force: true });
      deletedByQuota += 1;
    } catch {}
    currentSize = dirSizeBytes(DATASETS_ROOT);
  }
  return { blocked: currentSize > maxBytes, deletedByAge, deletedByQuota, currentSize, maxBytes };
}

function appendControlLog(controlLogPath, entry) {
  if (!controlLogPath) return;
  try {
    fs.appendFileSync(controlLogPath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {}
}

async function encodeCameraDirToMp4({ cameraDir, outMp4, fps, bitrate, crf, ffmpegBin }) {
  const { spawn } = require("child_process");
  return new Promise((resolve) => {
    const args = [
      "-y",
      "-framerate",
      String(Math.max(1, Number(fps || 10))),
      "-i",
      path.join(cameraDir, "%06d.jpg"),
      "-c:v",
      "libx264",
      "-b:v",
      String(bitrate || "2M"),
      "-crf",
      String(Number.isFinite(crf) ? crf : 23),
      "-pix_fmt",
      "yuv420p",
      outMp4
    ];
    const proc = spawn(ffmpegBin, args, { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", (err) => resolve({ ok: false, error: err.message }));
    proc.on("close", (code) => {
      if (code !== 0) return resolve({ ok: false, error: `ffmpeg exit ${code}: ${stderr.slice(-400)}` });
      resolve({ ok: true, videoPath: outMp4 });
    });
  });
}

function getDiskFreeBytes(targetPath) {
  try {
    const { execSync } = require("child_process");
    if (process.platform === "win32") {
      const drive = path.parse(path.resolve(targetPath)).root.replace(/[\\/:]/g, "");
      if (!drive) return null;
      const out = execSync(`wmic logicaldisk where DeviceID="${drive}:" get FreeSpace /value`, {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true
      }).toString();
      const match = out.match(/FreeSpace=(\d+)/);
      return match ? Number(match[1]) : null;
    }
    const out = execSync(`df -k "${targetPath}" | tail -1`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const parts = out.split(/\s+/);
    if (parts.length < 4) return null;
    return Number(parts[3]) * 1024;
  } catch {
    return null;
  }
}




