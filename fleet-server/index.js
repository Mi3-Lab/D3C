const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const os = require("os");
const crypto = require("crypto");
const express = require("express");
const { WebSocketServer, WebSocket } = require("ws");
const { DEFAULT_RUN_CONFIG, STATE_BROADCAST_HZ, DATASETS_ROOT } = require("./config");
const { sanitizeRunConfig, WS_ROLES } = require("./shared/schema");
const { MotionState } = require("./compute/motion_state");
const { SyncTracker } = require("./compute/sync_tracker");
const { SessionManager } = require("./session/session_manager");

const AUTH_STATE_PATH = path.join(process.cwd(), "fleet-server", "auth_state.json");
const PHONE_JOIN_TOKEN_TTL_MS = 5 * 60 * 1000;
const AUTH_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const AUTH_RATE_LIMIT_MAX_ATTEMPTS = 10;

const args = parseArgs(process.argv.slice(2));
const useHttps = !!(args.cert && args.key);
if ((args.cert && !args.key) || (!args.cert && args.key)) {
  console.error("Provide both --cert and --key, or neither for HTTP mode.");
  process.exit(1);
}

const app = express();
app.use(express.static(path.join(process.cwd(), "client-mobile")));
app.use(express.static(path.join(process.cwd(), "dashboard")));
app.use("/datasets", express.static(DATASETS_ROOT));
app.use("/sessions", express.static(DATASETS_ROOT));
app.get("/phone", (_req, res) => res.sendFile(path.join(process.cwd(), "client-mobile", "phone.html")));
app.get("/dashboard", (_req, res) => res.sendFile(path.join(process.cwd(), "dashboard", "dashboard.html")));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.post("/api/phone/auth", express.json(), (req, res) => {
  pruneAuthRateLimit();
  prunePhoneAuthTokens();
  const clientIp = getClientIp(req);
  const rateState = registerAuthAttempt(clientIp);
  if (rateState.blocked) {
    return res.status(429).json({
      ok: false,
      error: "rate_limited",
      retry_after_sec: Math.max(1, Math.ceil((rateState.retry_at_ms - Date.now()) / 1000))
    });
  }
  const joinCode = normalizeJoinCode(req.body?.join_code);
  const deviceName = sanitizeDeviceName(req.body?.device_name);
  const requestedDeviceId = sanitizeDeviceId(String(req.body?.device_id || "").trim());
  if (!deviceName) return res.status(400).json({ ok: false, error: "device_name_required" });
  if (!joinCode) return res.status(400).json({ ok: false, error: "join_code_required" });
  if (joinCode !== sessionAuth.joinCode) return res.status(403).json({ ok: false, error: "invalid_join_code" });
  const deviceId = requestedDeviceId || `iphone-${crypto.randomBytes(3).toString("hex")}`;
  const joinToken = crypto.randomBytes(24).toString("hex");
  const expiresAtMs = Date.now() + PHONE_JOIN_TOKEN_TTL_MS;
  phoneAuthTokens.set(joinToken, {
    device_id: deviceId,
    device_name: deviceName,
    expires_at_ms: expiresAtMs
  });
  res.json({
    ok: true,
    join_token: joinToken,
    expires_at_ms: expiresAtMs,
    device_id: deviceId,
    device_name: deviceName
  });
});
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
    syncReportJson: toUrlIfExists(path.join(root, "sync_report.json"), `/datasets/${id}/sync_report.json`),
    imuCsv: toUrlIfExists(path.join(streamRoot, "imu.csv"), `/datasets/${id}/devices/${deviceId}/streams/imu.csv`),
    imuParquet: toUrlIfExists(path.join(streamRoot, "imu.parquet"), `/datasets/${id}/devices/${deviceId}/streams/imu.parquet`),
    audioCsv: toUrlIfExists(path.join(streamRoot, "audio.csv"), `/datasets/${id}/devices/${deviceId}/streams/audio.csv`),
    audioParquet: toUrlIfExists(path.join(streamRoot, "audio.parquet"), `/datasets/${id}/devices/${deviceId}/streams/audio.parquet`),
    audioWav: toUrlIfExists(path.join(streamRoot, "audio.wav"), `/datasets/${id}/devices/${deviceId}/streams/audio.wav`),
    deviceCsv: toUrlIfExists(path.join(streamRoot, "device.csv"), `/datasets/${id}/devices/${deviceId}/streams/device.csv`),
    deviceParquet: toUrlIfExists(path.join(streamRoot, "device.parquet"), `/datasets/${id}/devices/${deviceId}/streams/device.parquet`),
    fusionCsv: toUrlIfExists(path.join(streamRoot, "fusion.csv"), `/datasets/${id}/devices/${deviceId}/streams/fusion.csv`),
    fusionParquet: toUrlIfExists(path.join(streamRoot, "fusion.parquet"), `/datasets/${id}/devices/${deviceId}/streams/fusion.parquet`),
    eventsCsv: toUrlIfExists(path.join(streamRoot, "events.csv"), `/datasets/${id}/devices/${deviceId}/streams/events.csv`),
    eventsParquet: toUrlIfExists(path.join(streamRoot, "events.parquet"), `/datasets/${id}/devices/${deviceId}/streams/events.parquet`),
    netCsv: toUrlIfExists(path.join(streamRoot, "net.csv"), `/datasets/${id}/devices/${deviceId}/streams/net.csv`),
    netParquet: toUrlIfExists(path.join(streamRoot, "net.parquet"), `/datasets/${id}/devices/${deviceId}/streams/net.parquet`),
    gpsCsv: toUrlIfExists(path.join(streamRoot, "gps.csv"), `/datasets/${id}/devices/${deviceId}/streams/gps.csv`),
    gpsParquet: toUrlIfExists(path.join(streamRoot, "gps.parquet"), `/datasets/${id}/devices/${deviceId}/streams/gps.parquet`),
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

const server = useHttps
  ? https.createServer(
      { cert: fs.readFileSync(args.cert), key: fs.readFileSync(args.key) },
      app
    )
  : http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const sessionManager = new SessionManager();

const devices = new Map(); // device_id -> device entry
const dashboardSockets = new Set();
const pendingCameraHeaderBySocket = new Map(); // ws -> header

let focusedDeviceId = null;
let sessionConfig = sanitizeRunConfig(DEFAULT_RUN_CONFIG, DEFAULT_RUN_CONFIG);
const sessionAuth = loadAuthState();
const phoneAuthTokens = new Map();
const phoneAuthRateLimit = new Map();
const connectionStats = { sockets_connected: 0, sockets_closed: 0, phones_connected: 0, phones_disconnected: 0, dashboards_connected: 0, dashboards_disconnected: 0 };

const recording = {
  active: false,
  phase: "IDLE",
  mode: "focused",
  session_dir: null,
  session_id: null,
  started_at_ms: null,
  target_device_ids: [],
  last_error: null,
  stop_requested_at_ms: null
};

wss.on("connection", (ws) => {
  connectionStats.sockets_connected += 1;
  console.log("[ws] socket connected", { sockets_connected: connectionStats.sockets_connected, sockets_closed: connectionStats.sockets_closed });
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
      console.log("[ws] hello", { role: msg.role, device_id: msg.device_id || msg.deviceId || null, device_name: msg.deviceName || null });
      handleHello(ws, msg);
      return;
    }
    if (ws.role === "phone") handlePhoneJson(ws, msg);
    if (ws.role === "dashboard") handleDashboardJson(ws, msg);
  });

  ws.on("close", () => {
    connectionStats.sockets_closed += 1;
    if (ws.role === "phone") connectionStats.phones_disconnected += 1;
    if (ws.role === "dashboard") connectionStats.dashboards_disconnected += 1;
    console.log("[ws] socket closed", { role: ws.role, device_id: ws.device_id, sockets_connected: connectionStats.sockets_connected, sockets_closed: connectionStats.sockets_closed, phones_connected: connectionStats.phones_connected, phones_disconnected: connectionStats.phones_disconnected });
    pendingCameraHeaderBySocket.delete(ws);
    if (ws.role === "phone") {
      const d = devices.get(ws.device_id);
      if (d && d.ws === ws) {
        d.connected = false;
        d.ws = null;
        d.lastSeenTs = Date.now();
        d.recordingStatus.recording = false;
        d.recordingStatus.modalities = { imu: false, cam: false, audio: false };
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
  pruneAuthRateLimit();
  prunePhoneAuthTokens();
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
      droppedPackets: d.stats.dropped_packets,
      lastSeenMs: d.lastSeenTs
    });
    if (recording.active && sessionManager.shouldRecordDevice(id)) {
      sessionManager.writeNet(id, {
        t_recv_ms: Date.now(),
        t_server_rx_ns: nowServerRxNs(),
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
  broadcastRecordStatuses();
}, 1000);

setInterval(() => {
  for (const [deviceId, d] of devices.entries()) {
    if (!d.connected || !d.ws || d.ws.readyState !== WebSocket.OPEN) continue;
    const pingId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const t1 = Date.now();
    d.syncTracker?.recordPingSent(pingId, t1);
    sendWs(d.ws, { type: "sync_ping", ping_id: pingId, t1_server_send_ms: t1 }, { critical: true });
  }
}, 1000);

const stateIntervalMs = Math.round(1000 / STATE_BROADCAST_HZ);
setInterval(() => {
  broadcastState();
  if (recording.phase !== "IDLE") broadcastRecordStatuses();
  broadcastDeviceList();
}, stateIntervalMs);

server.listen(args.port, args.host, () => {
  const protocol = useHttps ? "https" : "http";
  const wsProtocol = useHttps ? "wss" : "ws";
  const lanIp = getLanIp(args.lanIp);
  console.log(`Server running at ${protocol}://${lanIp}:${args.port}`);
  console.log(`Dashboard: ${protocol}://localhost:${args.port}/dashboard`);
  console.log(`Phone: ${protocol}://${lanIp}:${args.port}/phone`);
  console.log(`WebSocket: ${wsProtocol}://${lanIp}:${args.port}/ws`);
  console.log(`Health: ${protocol}://${lanIp}:${args.port}/health`);
  console.log(`Firewall reminder: allow inbound TCP ${args.port} on Private networks.`);
});

function handleHello(ws, msg) {
  if (!WS_ROLES.includes(msg.role)) return;
  ws.role = msg.role;

  if (ws.role === "dashboard") {
    ws.client_id = `dash_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    connectionStats.dashboards_connected += 1;
    console.log("[ws] dashboard registered", {
      dashboards_connected: connectionStats.dashboards_connected,
      dashboards_disconnected: connectionStats.dashboards_disconnected
    });
    dashboardSockets.add(ws);
    sendWs(ws, { type: "device_list", devices: deviceSummaries() });
    sendWs(ws, { type: "focus", focused_device_id: focusedDeviceId });
    sendWs(ws, buildSessionConfigPayload());
    if (focusedDeviceId && devices.has(focusedDeviceId)) {
      sendWs(ws, { type: "config", device_id: focusedDeviceId, runConfig: devices.get(focusedDeviceId).config });
    }
    for (const [id, d] of devices.entries()) {
      refreshDeviceRecordingStatus(id, d);
      sendWs(ws, buildRecordStatusPayload(id, d));
    }
    return;
  }

  const authGrant = validatePhoneAuthGrant(msg.join_token);
  if (!authGrant) {
    sendWs(ws, { type: "auth_required", error: "invalid_or_expired_join_token" }, { critical: true });
    try { ws.close(4401, "unauthorized"); } catch {}
    return;
  }
  const requested = authGrant.device_id || String(msg.deviceId || msg.device_id || "").trim() || `iphone-${Math.random().toString(36).slice(2, 6)}`;
  const { assigned, reused, renamed } = resolvePhoneDeviceId(requested, ws);
  const unique = assigned;
  ws.device_id = unique;

  const existing = devices.get(unique) || newDeviceEntry(unique);
  const hadPriorSocket = !!existing.ws && existing.ws !== ws;
  if (hadPriorSocket) {
    try { existing.ws.close(4001, "replaced by reconnect"); } catch {}
  }
  existing.ws = ws;
  existing.connected = true;
  existing.connectedAt = Date.now();
  existing.lastSeenTs = Date.now();
  existing.user_agent = msg.user_agent || null;
  existing.device_name = authGrant.device_name || existing.device_name || unique;
  existing.capabilities = msg.capabilities && typeof msg.capabilities === "object"
    ? { ...msg.capabilities }
    : (existing.capabilities || {});
  existing.config = clone(sessionConfig);
  if (reused) existing.syncTracker?.startSegment(Date.now(), "reconnect");
  devices.set(unique, existing);

  if (!focusedDeviceId) focusedDeviceId = unique;

  connectionStats.phones_connected += 1;
  sendWs(ws, {
    type: "hello_ack",
    device_id: unique,
    device_name: existing.device_name,
    renamed_from: renamed ? requested : null,
    reused_device_id: !!reused
  });
  console.log("[ws] phone registered", {
    requested,
    assigned: unique,
    device_name: existing.device_name,
    phones_connected: connectionStats.phones_connected,
    phones_disconnected: connectionStats.phones_disconnected
  });
  sendWs(ws, { type: "config", device_id: unique, runConfig: sessionConfig });
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
    const tServerRxNs = nowServerRxNs();
    const mag = Math.sqrt(ax * ax + ay * ay + az * az);
    const motion = d.motion.update(ax, ay, az);

    if (motion.motion_state === "STILL") d.stillSinceMs ||= tRecvMs;
    else d.stillSinceMs = null;

    d.state.motion_state = motion.motion_state;
    d.state.motion_conf = motion.confidence;
    d.state.inactivity_duration_sec = d.stillSinceMs ? Number(((tRecvMs - d.stillSinceMs) / 1000).toFixed(1)) : 0;
    d.state.imu_latest = {
      t_recv_ms: tRecvMs,
      t_server_rx_ns: tServerRxNs,
      t_device_ms: Number(msg.t_device_ms || 0),
      accel_mps2: [ax, ay, az],
      gyro_rads: [gx, gy, gz],
      mag
    };
    d.stats.imu_count += 1;
    trackDeviceClockSample(d, Number(msg.t_device_ms || 0), tRecvMs);

    if (recording.active) {
      sessionManager.writeImu(deviceId, {
        t_recv_ms: tRecvMs,
        t_device_ms: Number(msg.t_device_ms || 0),
        ax, ay, az, gx, gy, gz,
        t_server_rx_ns: tServerRxNs
      });
      markDeviceWrite(deviceId, tRecvMs);
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
    const tServerRxNs = nowServerRxNs();
    trackDeviceClockSample(d, Number(msg.t_device_ms || 0), tRecvMs);
    d.state.audio_latest = {
      t_recv_ms: tRecvMs,
      t_device_ms: Number(msg.t_device_ms || 0),
      amplitude: Number(msg.amplitude || 0),
      noise_level: Number(msg.noise_level || 0),
      t_server_rx_ns: tServerRxNs
    };
    if (recording.active) {
      sessionManager.writeAudio(deviceId, {
        t_recv_ms: tRecvMs,
        t_device_ms: Number(msg.t_device_ms || 0),
        amplitude: Number(msg.amplitude || 0),
        noise_level: Number(msg.noise_level || 0),
        t_server_rx_ns: tServerRxNs
      });
      markDeviceWrite(deviceId, tRecvMs);
    }
    return;
  }

  if (msg.type === "gps") {
    if (!allowByRate(d, "gps", d.config.streams.gps.rate_hz || 1)) return;
    const tRecvMs = Date.now();
    const tServerRxNs = nowServerRxNs();
    const lat = Number(msg.lat || 0);
    const lon = Number(msg.lon || 0);
    const accuracy_m = Number(msg.accuracy_m || -1);
    const speed_mps = Number(msg.speed_mps || -1);
    const heading_deg = Number(msg.heading_deg || -1);
    const altitude_m = Number(msg.altitude_m || -1);
    trackDeviceClockSample(d, Number(msg.t_device_ms || 0), tRecvMs);
    d.state.gps_latest = {
      t_recv_ms: tRecvMs,
      t_device_ms: Number(msg.t_device_ms || 0),
      lat, lon, accuracy_m, speed_mps, heading_deg, altitude_m,
      t_server_rx_ns: tServerRxNs
    };
    if (recording.active) {
      sessionManager.writeGps(deviceId, {
        t_recv_ms: tRecvMs,
        t_device_ms: Number(msg.t_device_ms || 0),
        lat, lon, accuracy_m, speed_mps, heading_deg, altitude_m,
        t_server_rx_ns: tServerRxNs
      });
      markDeviceWrite(deviceId, tRecvMs);
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
    markDeviceWrite(deviceId, Date.now());
    return;
  }

  if (msg.type === "device") {
    if (!allowByRate(d, "device", d.config.streams.device.rate_hz || 1)) return;
    const tRecvMs = Date.now();
    const tServerRxNs = nowServerRxNs();
    trackDeviceClockSample(d, Number(msg.t_device_ms || 0), tRecvMs);
    d.state.device_latest = {
      t_recv_ms: tRecvMs,
      t_device_ms: Number(msg.t_device_ms || 0),
      battery_level: Number(msg.battery_level ?? -1),
      charging: !!msg.charging,
      orientation: String(msg.orientation || "unknown"),
      t_server_rx_ns: tServerRxNs
    };
    if (recording.active) {
      sessionManager.writeDevice(deviceId, {
        t_recv_ms: tRecvMs,
        t_device_ms: Number(msg.t_device_ms || 0),
        battery_level: Number(msg.battery_level ?? -1),
        charging: !!msg.charging,
        orientation: String(msg.orientation || "unknown"),
        t_server_rx_ns: tServerRxNs
      });
      markDeviceWrite(deviceId, tRecvMs);
    }
    return;
  }

  if (msg.type === "heartbeat") {
    d.lastSeenTs = Date.now();
    return;
  }

  if (msg.type === "event") {
    const tRecvMs = Date.now();
    const tServerRxNs = nowServerRxNs();
    const entry = { t_recv_ms: tRecvMs, label: String(msg.label || ""), source: "phone", device_id: deviceId };
    d.state.event_timeline.push(entry);
    if (d.state.event_timeline.length > 50) d.state.event_timeline.shift();
    if (recording.active) {
      sessionManager.writeEvent(deviceId, {
        t_recv_ms: tRecvMs,
        t_device_ms: Number(msg.t_device_ms || 0),
        label: entry.label,
        meta: { source: "phone" },
        t_server_rx_ns: tServerRxNs
      });
      markDeviceWrite(deviceId, tRecvMs);
    }
    return;
  }

  if (msg.type === "sync_pong") {
    const recvMs = Date.now();
    const syncSample = d.syncTracker?.recordPong(msg, recvMs);
    if (syncSample && Number.isFinite(syncSample.rtt)) {
      d.stats.rtt_ms = Number(syncSample.rtt.toFixed(2));
    }
    const t3 = Number(msg.t3_device_send_mono_ms);
    if (Number.isFinite(t3) && t3 > 0) {
      trackDeviceClockSample(d, t3, recvMs);
    }
    return;
  }

  if (msg.type === "pong") {
    const recvMs = Date.now();
    const tPingRecvMs = Number(msg.t_ping_recv_ms);
    if (Number.isFinite(tPingRecvMs) && tPingRecvMs > 0) {
      trackDeviceClockSample(d, tPingRecvMs, recvMs);
    }
    return;
  }
}

function handlePhoneBinary(ws, data) {
  const d = devices.get(ws.device_id);
  if (!d) return;
  const header = pendingCameraHeaderBySocket.get(ws);
  if (!header) return;
  pendingCameraHeaderBySocket.delete(ws);
  const tRecvMs = Date.now();
  const tServerRxNs = nowServerRxNs();
  d.latestCameraBuffer = Buffer.from(data);
  d.latestCameraMime = header.format === "jpeg" ? "image/jpeg" : "application/octet-stream";
  d.state.camera_latest_ts = tRecvMs;
  trackDeviceClockSample(d, Number(header.t_device_ms || 0), tRecvMs);
  if (Number.isFinite(header.lighting_score)) d.state.camera_quality.lighting_score = header.lighting_score;
  d.stats.camera_count += 1;
  if (recording.active) {
    sessionManager.writeCamera(ws.device_id, {
      jpegBuffer: d.latestCameraBuffer,
      t_device_ms: header.t_device_ms,
      t_recv_ms: tRecvMs,
      t_server_rx_ns: tServerRxNs
    });
    markDeviceWrite(ws.device_id, tRecvMs);
  }
}

function handleDashboardJson(ws, msg) {
  if (msg.type === "set_focus") {
    const id = String(msg.device_id || "");
    if (devices.has(id)) focusedDeviceId = id;
    sendWs(ws, { type: "focus", focused_device_id: focusedDeviceId });
    sendWs(ws, buildSessionConfigPayload());
    if (focusedDeviceId && devices.has(focusedDeviceId)) {
      sendWs(ws, {
        type: "config",
        device_id: focusedDeviceId,
        runConfig: devices.get(focusedDeviceId).config
      });
    }
    broadcastState();
    return;
  }

  if (msg.type === "set_config") {
    // Backward-compatible alias: treat old per-device config command as global session config update.
    const incoming = msg.runConfig && typeof msg.runConfig === "object" ? msg.runConfig : null;
    if (!incoming) return;
    if (recording.active && msg.force !== true) {
      sendWs(ws, { type: "session_config_rejected", reason: "session_active", sessionState: "active" });
      return;
    }
    sessionConfig = sanitizeRunConfig(incoming, sessionConfig);
    for (const [id, d] of devices.entries()) {
      d.config = clone(sessionConfig);
      sessionManager.updateDeviceConfig(id, d.config);
      sendWs(d.ws, { type: "config", device_id: id, runConfig: d.config });
    }
    broadcastToDashboards(buildSessionConfigPayload());
    broadcastState();
    return;
  }

  if (msg.type === "session_auth_update") {
    const nextJoinCode = normalizeJoinCode(msg.joinCode);
    if (recording.active && msg.force !== true) {
      sendWs(ws, { type: "session_auth_rejected", reason: "session_active", sessionState: "active" });
      return;
    }
    if (!nextJoinCode || nextJoinCode.length < 4) {
      sendWs(ws, { type: "session_auth_rejected", reason: "invalid_join_code", sessionState: recording.active ? "active" : "draft" });
      return;
    }
    sessionAuth.joinCode = nextJoinCode;
    sessionAuth.updated_at_ms = Date.now();
    phoneAuthTokens.clear();
    persistAuthState(sessionAuth);
    broadcastToDashboards(buildSessionConfigPayload());
    return;
  }

  if (msg.type === "session_config_update") {
    if (!msg.sessionConfig || typeof msg.sessionConfig !== "object") return;
    if (recording.active && msg.force !== true) {
      sendWs(ws, { type: "session_config_rejected", reason: "session_active", sessionState: "active" });
      return;
    }
    sessionConfig = sanitizeRunConfig(msg.sessionConfig, sessionConfig);
    for (const [id, d] of devices.entries()) {
      d.config = clone(sessionConfig);
      sessionManager.updateDeviceConfig(id, d.config);
      sendWs(d.ws, { type: "config", device_id: id, runConfig: d.config });
    }
    broadcastToDashboards(buildSessionConfigPayload());
    broadcastState();
    return;
  }

  if (msg.type === "session_start") {
    const modalities = [];
    if (sessionConfig.streams.imu.enabled) modalities.push("imu");
    if (sessionConfig.streams.camera.mode === "stream") modalities.push("cam");
    if (sessionConfig.streams.audio.enabled) modalities.push("audio");
    startRecordingSession({
      scope: "all",
      session_name: msg.session_name || null,
      modalities: modalities.length ? modalities : ["imu", "cam", "audio"]
    });
    return;
  }

  if (msg.type === "session_stop") {
    void stopRecordingSession({ scope: "all", session_id: recording.session_id || null });
    return;
  }

  if (msg.type === "record_start") {
    startRecordingSession({
      scope: msg.scope,
      session_name: msg.session_name || null,
      modalities: Array.isArray(msg.modalities) ? msg.modalities : ["imu", "cam", "audio"]
    });
    return;
  }

  if (msg.type === "record_stop") {
    void stopRecordingSession({ scope: msg.scope, session_id: msg.session_id || recording.session_id || null });
    return;
  }

  if (msg.type === "recording") {
    if (msg.action === "start") {
      startRecordingSession({
        scope: msg.scope,
        session_name: msg.session_name_optional || null,
        modalities: ["imu", "cam", "audio"]
      });
    } else if (msg.action === "stop") {
      void stopRecordingSession({ scope: msg.scope, session_id: recording.session_id || null });
    }
    return;
  }

  if (msg.type === "event") {
    const deviceId = String(msg.device_id || focusedDeviceId || "");
    if (!deviceId || !devices.has(deviceId)) return;
    const d = devices.get(deviceId);
    const tRecvMs = Date.now();
    const tServerRxNs = nowServerRxNs();
    const entry = { t_recv_ms: tRecvMs, label: String(msg.label || ""), source: "dashboard", device_id: deviceId };
    d.state.event_timeline.push(entry);
    if (d.state.event_timeline.length > 50) d.state.event_timeline.shift();
    if (recording.active) {
      sessionManager.writeEvent(deviceId, {
        t_recv_ms: tRecvMs,
        t_device_ms: 0,
        label: entry.label,
        meta: { source: "dashboard" },
        t_server_rx_ns: tServerRxNs
      });
      markDeviceWrite(deviceId, tRecvMs);
    }
  }
}
function startRecordingSession({ scope, session_name, modalities = ["imu", "cam", "audio"] }) {
  if (recording.phase === "STOPPING") return;
  if (recording.active) return;
  if (DEFAULT_RUN_CONFIG.storage?.auto_cleanup) {
    const cleanup = runStorageCleanupPolicy(DEFAULT_RUN_CONFIG.storage);
    if (cleanup.blocked) {
      recording.last_error = { type: "storage_quota_exceeded", details: cleanup };
      broadcastToDashboards({ type: "recording_error", error: "storage_quota_exceeded", details: cleanup });
      return;
    }
  }
  // Recording is fleet-wide by design: focus mode is view-only.
  const mode = "all";
  const connectedEntries = [...devices.entries()].filter(([, d]) => d.connected);
  const targetEntries = connectedEntries;
  const deviceConfigs = new Map(targetEntries.map(([id, d]) => [id, d.config]));
  const deviceDetails = Object.fromEntries(targetEntries.map(([id, d]) => [id, {
    user_agent: d.user_agent || null,
    connected_at_ms: d.connectedAt || null,
    last_seen_ms: d.lastSeenTs || null
  }]));
  if (!deviceConfigs.size) return;
  const res = sessionManager.start({
    mode,
    focusedDeviceId: focusedDeviceId || null,
    devicesConfigMap: deviceConfigs,
    extraMeta: {
      laptop_ip: getLanIp(args.lanIp),
      device_details: deviceDetails,
      session_name: session_name || null,
      requested_modalities: modalities
    }
  });
  const startedAt = Date.now();
  const sid = shortSessionId(res.sessionDir);
  recording.active = true;
  recording.phase = "RECORDING";
  recording.mode = mode;
  recording.session_dir = res.sessionDir;
  recording.session_id = sid;
  recording.started_at_ms = startedAt;
  recording.target_device_ids = targetEntries.map(([id]) => id);
  recording.last_error = null;
  recording.stop_requested_at_ms = null;

  for (const [id, d] of devices.entries()) {
    const targeted = recording.target_device_ids.includes(id);
    if (targeted) {
      d.recordingStatus.recording = true;
      d.recordingStatus.session_id = sid;
      d.recordingStatus.started_at_utc_ms = startedAt;
      d.recordingStatus.modalities = { imu: false, cam: false, audio: false };
      d.recordingStatus.writer = { last_write_utc_ms: null, dropped: 0 };
      d.recordingStatus.files = {};
      d.recordingStatus.error = null;
    } else if (!recording.active) {
      d.recordingStatus.recording = false;
    }
  }

  broadcastState();
  broadcastDeviceList();
  broadcastRecordStatuses();
}

async function stopRecordingSession() {
  if (recording.phase === "STOPPING") return;
  if (!recording.active) return;

  recording.phase = "STOPPING";
  recording.stop_requested_at_ms = Date.now();
  broadcastState();
  broadcastRecordStatuses();

  const stoppingSessionId = recording.session_id;
  const stoppingTargets = [...recording.target_device_ids];
  const res = sessionManager.stop();
  const finalizeTasks = Array.isArray(res.finalizeTasks) ? res.finalizeTasks : [];
  const timeoutMs = 300000;
  let timedOut = false;

  if (finalizeTasks.length) {
    const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve("timeout"), timeoutMs));
    const settled = await Promise.race([Promise.allSettled(finalizeTasks), timeoutPromise]);
    if (settled === "timeout") timedOut = true;
  }

  writeSyncReport(res.sessionDir, stoppingSessionId, stoppingTargets, {
    timedOut,
    timeout_ms: timeoutMs,
    finalize_tasks: finalizeTasks.length
  });

  for (const id of stoppingTargets) {
    const d = devices.get(id);
    if (!d) continue;
    d.recordingStatus.recording = false;
    d.recordingStatus.modalities = { imu: false, cam: false, audio: false };
    d.recordingStatus.files = collectStoppedFiles(res.sessionDir, id);
    d.recordingStatus.writer = { ...d.recordingStatus.writer, dropped: d.stats?.dropped_packets || 0 };
    broadcastToDashboards({
      type: "record_stopped",
      device_id: id,
      session_id: stoppingSessionId,
      files: d.recordingStatus.files
    });
  }

  recording.active = false;
  recording.phase = "IDLE";
  recording.session_dir = res.sessionDir;
  recording.started_at_ms = null;
  recording.target_device_ids = [];
  recording.stop_requested_at_ms = null;
  recording.last_error = timedOut ? { type: "stop_timeout", timeout_ms: timeoutMs } : null;

  if (timedOut) {
    broadcastToDashboards({
      type: "recording_error",
      error: "stop_timeout",
      details: { timeout_ms: timeoutMs, session_id: stoppingSessionId, devices: stoppingTargets }
    });
  }

  broadcastState();
  broadcastDeviceList();
  broadcastRecordStatuses();
}

function broadcastRecordStatuses() {
  for (const [id, d] of devices.entries()) {
    refreshDeviceRecordingStatus(id, d);
    broadcastToDashboards(buildRecordStatusPayload(id, d));
  }
}

function refreshDeviceRecordingStatus(deviceId, d) {
  if (!d.recordingStatus) return;
  const writer = d.recordingStatus.writer || { last_write_utc_ms: null, dropped: 0 };
  writer.dropped = Number(d.stats?.dropped_packets || 0);
  d.recordingStatus.writer = writer;
  if (!d.recordingStatus.recording) return;
  const flags = sessionManager.getActiveRecorderFlags(deviceId);
  d.recordingStatus.modalities = {
    imu: !!flags.imu,
    cam: !!flags.camera,
    audio: !!(flags.audio || flags.audioWav)
  };
}

function buildRecordStatusPayload(deviceId, d) {
  return {
    type: "record_status",
    device_id: deviceId,
    connected: !!d.connected,
    recording: !!d.recordingStatus?.recording,
    session_id: d.recordingStatus?.session_id || null,
    started_at_utc_ms: d.recordingStatus?.started_at_utc_ms || null,
    modalities: d.recordingStatus?.modalities || { imu: false, cam: false, audio: false },
    writer: d.recordingStatus?.writer || { last_write_utc_ms: null, dropped: 0 }
  };
}

function markDeviceWrite(deviceId, tRecvMs) {
  const d = devices.get(deviceId);
  if (!d || !d.recordingStatus) return;
  if (!d.recordingStatus.writer) d.recordingStatus.writer = { last_write_utc_ms: null, dropped: 0 };
  d.recordingStatus.writer.last_write_utc_ms = Number(tRecvMs || Date.now());
}
function countDevicesRecording() {
  let n = 0;
  for (const d of devices.values()) if (d.recordingStatus?.recording) n += 1;
  return n;
}

function shortSessionId(sessionDir) {
  const base = path.basename(String(sessionDir || ""));
  const tail = base.replace(/^session_/, "");
  const compact = tail.replace(/[^A-Za-z0-9]/g, "");
  return (compact.slice(-4) || Math.random().toString(36).slice(2, 6)).toUpperCase();
}

function collectStoppedFiles(sessionDir, deviceId) {
  const out = {};
  try {
    const streamsDir = path.join(sessionDir || "", "devices", sanitizeDeviceId(deviceId), "streams");
    if (fs.existsSync(path.join(streamsDir, "imu.parquet"))) out.imu = "imu.parquet";
    else if (fs.existsSync(path.join(streamsDir, "imu.csv"))) out.imu = "imu.csv";
    if (fs.existsSync(path.join(streamsDir, "camera_video.mp4"))) out.cam = "camera_video.mp4";
    else if (fs.existsSync(path.join(streamsDir, "camera"))) out.cam = "camera/";
    if (fs.existsSync(path.join(streamsDir, "audio.wav"))) out.audio = "audio.wav";
    else if (fs.existsSync(path.join(streamsDir, "audio.parquet"))) out.audio = "audio.parquet";
    else if (fs.existsSync(path.join(streamsDir, "audio.csv"))) out.audio = "audio.csv";
  } catch {}
  return out;
}

function broadcastState() {
  const focused = focusedDeviceId ? devices.get(focusedDeviceId) : null;
  const allStates = {};
  for (const [id, d] of devices.entries()) {
    allStates[id] = publicStateForDevice(id, d);
  }
  const payload = {
    type: "state",
    focused_device_id: focusedDeviceId,
    focused: focused ? publicStateForDevice(focusedDeviceId, focused) : null,
    device_states: allStates,
    devices: deviceSummaries(),
    sessionConfig,
    sessionState: recording.active ? "active" : "draft",
    recording: {
      active: recording.active,
      phase: recording.phase,
      mode: recording.mode,
      session_id: recording.session_id,
      session_dir: recording.session_dir,
      started_at_utc_ms: recording.started_at_ms,
      elapsed_sec: recording.started_at_ms ? Math.max(0, Math.round((Date.now() - recording.started_at_ms) / 1000)) : 0,
      devices_recording: countDevicesRecording(),
      devices_online: [...devices.values()].filter((d) => d.connected).length,
      target_device_ids: recording.target_device_ids,
      last_error: recording.last_error
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
      droppedPackets: d.stats.dropped_packets,
      connectionStatus: d.connectionStatus || "disconnected",
      deviceName: d.device_name || id,
      capabilities: d.capabilities || {},
      recordingActive: !!d.recordingStatus?.recording,
      recordingState: d.recordingStatus?.recording ? "recording" : (d.connected ? "armed" : "idle"),
      recordingModalities: d.recordingStatus?.modalities || { imu: false, cam: false, audio: false },
      recordingSessionId: d.recordingStatus?.session_id || null,
      healthAlerts: computeDeviceAlerts(d),
      syncSummary: summarizeSyncStats(d)
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

function isSocketOpen(sock) {
  return !!sock && sock.readyState === WebSocket.OPEN;
}

function resolvePhoneDeviceId(requested, incomingWs) {
  const existing = devices.get(requested);
  if (!existing) return { assigned: requested, reused: false, renamed: false };
  if (!existing.connected || !isSocketOpen(existing.ws) || existing.ws === incomingWs) {
    return { assigned: requested, reused: true, renamed: false };
  }
  const staleMs = Date.now() - Number(existing.lastSeenTs || 0);
  if (staleMs > 7000) {
    try { existing.ws?.close(4001, "replaced by reconnect"); } catch {}
    existing.ws = null;
    existing.connected = false;
    return { assigned: requested, reused: true, renamed: false };
  }
  return { assigned: uniqueDeviceId(requested), reused: false, renamed: true };
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
    device_name: null,
    capabilities: {},
    config: clone(DEFAULT_RUN_CONFIG),
    motion: new MotionState(60),
    syncTracker: new SyncTracker({ windowMs: 120000, minFitSamples: 8, lowRttFraction: 0.35 }),
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
      rtt_ms: null,
      sync: {
        ping_sent: 0,
        ping_acked: 0,
        rtt_samples: 0,
        rtt_sum_ms: 0,
        rtt_min_ms: null,
        rtt_max_ms: null,
        offset_samples: 0,
        offset_sum_ms: 0,
        offset_sq_sum_ms: 0,
        offset_min_ms: null,
        offset_max_ms: null,
        last_offset_ms: null,
        last_sync_recv_ms: null,
        anchor_device_ms: null,
        anchor_recv_ms: null
      }
    },
    lastGateMs: {},
    connectionStatus: "disconnected",
    recordingStatus: {
      recording: false,
      session_id: null,
      started_at_utc_ms: null,
      modalities: { imu: false, cam: false, audio: false },
      writer: { last_write_utc_ms: null, dropped: 0 },
      files: {},
      error: null
    }
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

function buildSessionConfigPayload() {
  return {
    type: "session_config",
    sessionConfig,
    sessionState: recording.active ? "active" : "draft",
    joinCode: sessionAuth.joinCode
  };
}

function createJoinCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function loadAuthState() {
  try {
    if (fs.existsSync(AUTH_STATE_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(AUTH_STATE_PATH, "utf8"));
      const joinCode = normalizeJoinCode(parsed?.joinCode);
      if (joinCode) {
        return {
          joinCode,
          updated_at_ms: Number(parsed?.updated_at_ms || Date.now())
        };
      }
    }
  } catch {}
  const state = { joinCode: createJoinCode(), updated_at_ms: Date.now() };
  persistAuthState(state);
  return state;
}

function persistAuthState(state) {
  try {
    fs.mkdirSync(path.dirname(AUTH_STATE_PATH), { recursive: true });
    fs.writeFileSync(AUTH_STATE_PATH, JSON.stringify({
      joinCode: normalizeJoinCode(state?.joinCode),
      updated_at_ms: Number(state?.updated_at_ms || Date.now())
    }, null, 2), "utf8");
  } catch {}
}

function normalizeJoinCode(value) {
  const normalized = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return normalized || "";
}

function sanitizeDeviceName(value) {
  const trimmed = String(value || "").trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  return trimmed.slice(0, 40);
}

function prunePhoneAuthTokens() {
  const now = Date.now();
  for (const [token, grant] of phoneAuthTokens.entries()) {
    if (!grant || Number(grant.expires_at_ms || 0) <= now) {
      phoneAuthTokens.delete(token);
    }
  }
}

function validatePhoneAuthGrant(token) {
  if (typeof token !== "string" || !token) return null;
  const grant = phoneAuthTokens.get(token);
  if (!grant) return null;
  if (Number(grant.expires_at_ms || 0) <= Date.now()) {
    phoneAuthTokens.delete(token);
    return null;
  }
  return grant;
}

function getClientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || String(req.socket?.remoteAddress || "unknown");
}

function registerAuthAttempt(clientIp) {
  const now = Date.now();
  const key = String(clientIp || "unknown");
  const existing = phoneAuthRateLimit.get(key);
  if (!existing || now >= existing.window_start_ms + AUTH_RATE_LIMIT_WINDOW_MS) {
    const fresh = { window_start_ms: now, attempts: 1, retry_at_ms: now + AUTH_RATE_LIMIT_WINDOW_MS };
    phoneAuthRateLimit.set(key, fresh);
    return { blocked: false, ...fresh };
  }
  existing.attempts += 1;
  existing.retry_at_ms = existing.window_start_ms + AUTH_RATE_LIMIT_WINDOW_MS;
  if (existing.attempts > AUTH_RATE_LIMIT_MAX_ATTEMPTS) {
    phoneAuthRateLimit.set(key, existing);
    return { blocked: true, ...existing };
  }
  phoneAuthRateLimit.set(key, existing);
  return { blocked: false, ...existing };
}

function pruneAuthRateLimit() {
  const now = Date.now();
  for (const [key, value] of phoneAuthRateLimit.entries()) {
    if (!value || now >= Number(value.window_start_ms || 0) + AUTH_RATE_LIMIT_WINDOW_MS) {
      phoneAuthRateLimit.delete(key);
    }
  }
}

function parseArgs(argv) {
  const out = { port: 3000, cert: null, key: null, host: "0.0.0.0", lanIp: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i] || 3000);
    else if (a === "--cert") out.cert = argv[++i] || null;
    else if (a === "--key") out.key = argv[++i] || null;
    else if (a === "--host") out.host = argv[++i] || "0.0.0.0";
    else if (a === "--lan-ip") out.lanIp = argv[++i] || "";
  }
  return out;
}

function getLanIp(preferred) {
  if (preferred) return preferred;
  const hotspotDefault = "192.168.137.1";
  const nets = os.networkInterfaces();
  for (const key of Object.keys(nets)) {
    for (const ni of nets[key] || []) {
      if (ni.family === "IPv4" && !ni.internal && ni.address === hotspotDefault) return ni.address;
    }
  }
  for (const key of Object.keys(nets)) {
    for (const ni of nets[key] || []) {
      if (ni.family === "IPv4" && !ni.internal) return ni.address;
    }
  }
  return hotspotDefault;
}

function sanitizeDeviceId(deviceId) {
  return String(deviceId || "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
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

function trackDeviceClockSample(deviceEntry, tDeviceMs, _tRecvMs) {
  if (!deviceEntry || !Number.isFinite(tDeviceMs) || tDeviceMs <= 0) return;
  deviceEntry.lastDeviceMonoMs = Number(tDeviceMs);
}
function summarizeSyncStats(d) {
  if (!d?.syncTracker) {
    return { ping_sent: 0, ping_acked: 0, ping_loss_pct: 0, mapping: null, quality: null, segments: [] };
  }
  const rep = d.syncTracker.buildReport(Date.now());
  return {
    ping_sent: rep.ping_sent,
    ping_acked: rep.ping_acked,
    ping_loss_pct: rep.ping_loss_pct,
    mapping: rep.mapping,
    quality: rep.quality,
    segments: rep.segments
  };
}
function computeDeviceAlerts(d) {
  const alerts = [];
  const now = Date.now();
  const stream = d?.config?.streams || {};
  const lastSeenAge = d?.lastSeenTs ? now - d.lastSeenTs : Number.POSITIVE_INFINITY;
  if (!d.connected) {
    alerts.push({ severity: "error", code: "disconnected", message: "Device disconnected" });
    return alerts;
  }
  if (lastSeenAge > 5000) alerts.push({ severity: "warn", code: "stale_link", message: `No packets for ${Math.round(lastSeenAge / 1000)}s` });

  if (stream.imu?.enabled) {
    const target = Number(stream.imu.rate_hz || 0);
    const actual = Number(d.stats.imu_hz || 0);
    if (target > 0 && actual < Math.max(1, target * 0.6)) {
      alerts.push({ severity: "warn", code: "imu_low_hz", message: `IMU low ${actual.toFixed(1)}/${target} Hz` });
    }
  }

  if (stream.camera?.mode === "stream") {
    const target = Number(stream.camera.fps || 0);
    const actual = Number(d.stats.camera_fps || 0);
    if (target > 0 && actual < Math.max(1, target * 0.6)) {
      alerts.push({ severity: "warn", code: "cam_low_fps", message: `Camera low ${actual.toFixed(1)}/${target} FPS` });
    }
  }

  if (stream.gps?.enabled) {
    const gpsTs = Number(d.state?.gps_latest?.t_recv_ms || 0);
    const gpsAge = gpsTs ? (now - gpsTs) : Number.POSITIVE_INFINITY;
    if (!gpsTs) alerts.push({ severity: "warn", code: "gps_no_fix", message: "GPS no fix" });
    else if (gpsAge > 15000) alerts.push({ severity: "warn", code: "gps_stale", message: `GPS stale ${Math.round(gpsAge / 1000)}s` });
  }

  const rtt = Number(d.stats.rtt_ms || 0);
  if (rtt > 350) alerts.push({ severity: "warn", code: "rtt_high", message: `High RTT ${Math.round(rtt)} ms` });
  const dropped = Number(d.stats.dropped_packets || 0);
  if (dropped > 8) alerts.push({ severity: "warn", code: "packet_drop", message: `Drops ${dropped}/s` });

  return alerts;
}

function writeSyncReport(sessionDir, sessionId, targetDeviceIds, extra = {}) {
  if (!sessionDir) return;
  try {
    const devicesReport = {};
    for (const id of targetDeviceIds || []) {
      const d = devices.get(id);
      if (!d) continue;
      devicesReport[id] = {
        device_id: id,
        device_name: d.device_name || id,
        connected: !!d.connected,
        connection_status: d.connectionStatus || "unknown",
        last_seen_ms: d.lastSeenTs || null,
        stream_health: {
          imu_hz: Number(d.stats.imu_hz || 0),
          camera_fps: Number(d.stats.camera_fps || 0),
          dropped_packets: Number(d.stats.dropped_packets || 0)
        },
        sync: summarizeSyncStats(d),
        alerts: computeDeviceAlerts(d)
      };
    }
    const report = {
      generated_at_iso: new Date().toISOString(),
      session_id: sessionId || null,
      recording_mode: recording.mode,
      target_device_ids: [...(targetDeviceIds || [])],
      device_count: Object.keys(devicesReport).length,
      ...extra,
      devices: devicesReport
    };
    fs.writeFileSync(path.join(sessionDir, "sync_report.json"), JSON.stringify(report, null, 2), "utf8");
    appendControlLog(path.join(sessionDir, "control_log.jsonl"), {
      type: "sync_report_written",
      at_iso: new Date().toISOString(),
      session_id: sessionId || null,
      device_count: report.device_count
    });
  } catch (err) {
    console.error("[sync-report] failed", err?.message || err);
  }
}
function nowServerRxNs() {
  return (BigInt(Date.now()) * 1000000n).toString();
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





























