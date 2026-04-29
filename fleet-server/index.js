const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const express = require("express");
const { WebSocketServer, WebSocket } = require("ws");
const { DEFAULT_RUN_CONFIG, STATE_BROADCAST_HZ, DATASETS_ROOT } = require("./config");
const { sanitizeRunConfig, WS_ROLES } = require("./shared/schema");
const { MotionState } = require("./compute/motion_state");
const { SyncTracker } = require("./compute/sync_tracker");
const { SessionManager } = require("./session/session_manager");
const { encodeCameraDirToMp4 } = require("./session/recorders/camera_recorder");
const {
  exportSessionMedia,
  EXPORTS_DIRNAME,
  SESSION_MULTIVIEW_NAME,
  SESSION_MULTIVIEW_WITH_AUDIO_NAME,
  SESSION_MULTIVIEW_WITH_AUDIO_AND_GPS_NAME,
  SESSION_MULTIVIEW_MANIFEST_NAME,
  SESSION_GPS_PLAYBACK_NAME,
  SESSION_GPS_PLAYBACK_VIDEO_NAME,
  CAMERA_WITH_AUDIO_NAME
} = require("./session/export_session_media");

const AUTH_STATE_PATH = process.env.AUTH_STATE_PATH
  ? path.resolve(process.env.AUTH_STATE_PATH)
  : path.join(process.cwd(), "fleet-server", "auth_state.json");
const PHONE_JOIN_TOKEN_TTL_MS = 5 * 60 * 1000;
const AUTH_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const AUTH_RATE_LIMIT_MAX_ATTEMPTS = 10;
const DASHBOARD_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DASHBOARD_AUTH_COOKIE = "d3c_dashboard_auth";
const DASHBOARD_PASSWORD = String(process.env.DASHBOARD_PASSWORD || "");
const DASHBOARD_AUTH_ENABLED = DASHBOARD_PASSWORD.trim().length > 0;
const PUBLIC_RUNTIME_STATE_PATH = process.env.PUBLIC_RUNTIME_STATE_PATH
  ? path.resolve(process.env.PUBLIC_RUNTIME_STATE_PATH)
  : "";
const SERVER_STARTED_AT_MS = Date.now();
const FLEET_OVERVIEW_BROADCAST_MIN_INTERVAL_MS = 500;
const FLEET_ALERT_ACK_TIMEOUT_MS = Math.max(
  500,
  Math.round(Number(process.env.FLEET_ALERT_ACK_TIMEOUT_MS || 1200) || 1200)
);
const FLEET_ALERT_MAX_RETRIES = Math.max(
  0,
  Math.round(Number(process.env.FLEET_ALERT_MAX_RETRIES || 2) || 2)
);
const FLEET_ALERT_RETENTION_MS = Math.max(
  FLEET_ALERT_ACK_TIMEOUT_MS * Math.max(2, FLEET_ALERT_MAX_RETRIES + 1),
  Math.round(Number(process.env.FLEET_ALERT_RETENTION_MS || 30000) || 30000)
);
const WORKZONE_ALERT_POLL_INTERVAL_MS = Math.max(
  100,
  Math.round(Number(process.env.WORKZONE_ALERT_POLL_INTERVAL_MS || 100) || 100)
);
const WORKZONE_ALERT_COOLDOWN_MS = Math.max(
  0,
  Math.round(Number(process.env.WORKZONE_ALERT_COOLDOWN_MS || 0) || 0)
);
const WORKZONE_ALERT_STALE_MS = 15000;
const WORKZONE_LIVE_ENABLE = String(process.env.WORKZONE_LIVE_ENABLE || "auto").trim().toLowerCase();
const WORKZONE_LIVE_PROJECT_DIR = path.resolve(String(
  process.env.WORKZONE_LIVE_PROJECT_DIR
  || process.env.WORKZONE_PROJECT_DIR
  || "/home/proy/projects/mi3/workzone"
));
const WORKZONE_LIVE_PYTHON = path.resolve(String(
  process.env.WORKZONE_LIVE_PYTHON
  || process.env.WORKZONE_PYTHON
  || "/home/proy/miniconda3/envs/workzone/bin/python"
));
const WORKZONE_LIVE_WEIGHTS = String(
  process.env.WORKZONE_LIVE_WEIGHTS
  || process.env.WORKZONE_WEIGHTS
  || "weights/yolo12s_hardneg_1280.pt"
).trim();
const WORKZONE_LIVE_DEVICE = String(
  process.env.WORKZONE_LIVE_DEVICE
  || process.env.WORKZONE_DEVICE
  || "cpu"
).trim() || "cpu";
const WORKZONE_LIVE_IMGSZ = Math.max(64, Math.round(Number(process.env.WORKZONE_LIVE_IMGSZ || 1280) || 1280));
const WORKZONE_LIVE_CONF = Math.max(0, Number(process.env.WORKZONE_LIVE_CONF || 0.18) || 0.18);
const WORKZONE_LIVE_IOU = Math.max(0, Number(process.env.WORKZONE_LIVE_IOU || 0.45) || 0.45);
const WORKZONE_LIVE_SCORE_THRESHOLD = Math.max(0, Number(process.env.WORKZONE_LIVE_SCORE_THRESHOLD || 0.40) || 0.40);
const WORKZONE_LIVE_CONFIG_PATH = String(process.env.WORKZONE_LIVE_CONFIG_PATH || "").trim();
const WORKZONE_LIVE_USE_CLIP = String(process.env.WORKZONE_LIVE_USE_CLIP || "auto").trim().toLowerCase() || "auto";
const WORKZONE_LIVE_ENABLE_PER_CUE = String(process.env.WORKZONE_LIVE_ENABLE_PER_CUE || "auto").trim().toLowerCase() || "auto";
const WORKZONE_LIVE_ENABLE_CONTEXT_BOOST = String(process.env.WORKZONE_LIVE_ENABLE_CONTEXT_BOOST || "auto").trim().toLowerCase() || "auto";
const WORKZONE_LIVE_SCENE_CONTEXT_ENABLE = String(process.env.WORKZONE_LIVE_SCENE_CONTEXT_ENABLE || "auto").trim().toLowerCase() || "auto";
const WORKZONE_LIVE_ENABLE_OCR = String(process.env.WORKZONE_LIVE_ENABLE_OCR || "auto").trim().toLowerCase() || "auto";
const WORKZONE_LIVE_OCR_FULL_FRAME = String(process.env.WORKZONE_LIVE_OCR_FULL_FRAME || "auto").trim().toLowerCase() || "auto";
const WORKZONE_LIVE_EMA_ALPHA = String(process.env.WORKZONE_LIVE_EMA_ALPHA || "").trim();
const WORKZONE_LIVE_ENTER_TH = String(process.env.WORKZONE_LIVE_ENTER_TH || "").trim();
const WORKZONE_LIVE_EXIT_TH = String(process.env.WORKZONE_LIVE_EXIT_TH || "").trim();
const WORKZONE_LIVE_APPROACH_TH = String(process.env.WORKZONE_LIVE_APPROACH_TH || "").trim();
const WORKZONE_LIVE_MIN_INSIDE_FRAMES = String(process.env.WORKZONE_LIVE_MIN_INSIDE_FRAMES || "").trim();
const WORKZONE_LIVE_MIN_OUT_FRAMES = String(process.env.WORKZONE_LIVE_MIN_OUT_FRAMES || "").trim();
const WORKZONE_LIVE_CLIP_WEIGHT = String(process.env.WORKZONE_LIVE_CLIP_WEIGHT || "").trim();
const WORKZONE_LIVE_CLIP_TRIGGER_TH = String(process.env.WORKZONE_LIVE_CLIP_TRIGGER_TH || "").trim();
const WORKZONE_LIVE_PER_CUE_TH = String(process.env.WORKZONE_LIVE_PER_CUE_TH || "").trim();
const WORKZONE_LIVE_CONTEXT_TRIGGER_BELOW = String(process.env.WORKZONE_LIVE_CONTEXT_TRIGGER_BELOW || "").trim();
const WORKZONE_LIVE_ORANGE_WEIGHT = String(process.env.WORKZONE_LIVE_ORANGE_WEIGHT || "").trim();
const WORKZONE_LIVE_OCR_EVERY_N = String(process.env.WORKZONE_LIVE_OCR_EVERY_N || "").trim();
const WORKZONE_LIVE_OCR_THRESHOLD = String(process.env.WORKZONE_LIVE_OCR_THRESHOLD || "").trim();
const WORKZONE_LIVE_SCENE_INTERVAL = String(process.env.WORKZONE_LIVE_SCENE_INTERVAL || "").trim();
const WORKZONE_LIVE_CLIP_INTERVAL = String(process.env.WORKZONE_LIVE_CLIP_INTERVAL || "").trim();
const WORKZONE_LIVE_PER_CUE_INTERVAL = String(process.env.WORKZONE_LIVE_PER_CUE_INTERVAL || "").trim();
const WORKZONE_LIVE_PING_INTERVAL_MS = Math.max(
  500,
  Math.round(Number(process.env.WORKZONE_LIVE_PING_INTERVAL_MS || 2500) || 2500)
);
const WORKZONE_LIVE_BUSY_TIMEOUT_MS = Math.max(
  2000,
  Math.round(Number(process.env.WORKZONE_LIVE_BUSY_TIMEOUT_MS || 8000) || 8000)
);
const WORKZONE_LIVE_RESTART_DELAY_MS = Math.max(
  250,
  Math.round(Number(process.env.WORKZONE_LIVE_RESTART_DELAY_MS || 1500) || 1500)
);
const WORKZONE_LIVE_RESULT_STALE_MS = Math.max(
  1000,
  Math.round(Number(process.env.WORKZONE_LIVE_RESULT_STALE_MS || 3500) || 3500)
);
const WORKZONE_LIVE_EVIDENCE_WINDOW_MS = Math.max(
  1000,
  Math.round(Number(process.env.WORKZONE_LIVE_EVIDENCE_WINDOW_MS || 2500) || 2500)
);
const WORKZONE_LIVE_ACTIVE_HOLD_MS = Math.max(
  500,
  Math.round(Number(process.env.WORKZONE_LIVE_ACTIVE_HOLD_MS || 1800) || 1800)
);
const WORKZONE_LIVE_MIN_POSITIVE_FRAMES = Math.max(
  1,
  Math.round(Number(process.env.WORKZONE_LIVE_MIN_POSITIVE_FRAMES || 1) || 1)
);
const WORKZONE_LIVE_ALERT_BANNER_MS = Math.max(
  1000,
  Math.round(Number(process.env.WORKZONE_LIVE_ALERT_BANNER_MS || 8000) || 8000)
);
const WORKZONE_LIVE_WORKER_SCRIPT = path.join(process.cwd(), "fleet-server", "workzone_live_worker.py");

const args = parseArgs(process.argv.slice(2));
const useHttps = !!(args.cert && args.key);
if ((args.cert && !args.key) || (!args.cert && args.key)) {
  console.error("Provide both --cert and --key, or neither for HTTP mode.");
  process.exit(1);
}

const app = express();
app.use(express.static(path.join(process.cwd(), "client-mobile")));
app.get("/phone", (_req, res) => res.sendFile(path.join(process.cwd(), "client-mobile", "phone.html")));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/styles.css", (_req, res) => res.sendFile(path.join(process.cwd(), "dashboard", "styles.css")));
app.get("/dashboard/login", (req, res) => {
  if (isDashboardRequestAuthorized(req)) {
    return res.redirect(302, "/dashboard");
  }
  res.type("html").send(buildDashboardLoginPage(getDashboardRedirectTarget(req.query.next)));
});
app.post("/api/dashboard/login", express.json(), (req, res) => {
  if (!DASHBOARD_AUTH_ENABLED) return res.json({ ok: true, auth_enabled: false });
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!verifyDashboardPassword(password)) {
    return res.status(401).json({ ok: false, error: "invalid_dashboard_password" });
  }
  const token = createDashboardSession();
  setDashboardAuthCookie(res, token);
  res.json({ ok: true, auth_enabled: true });
});
app.post("/api/dashboard/logout", (req, res) => {
  const token = getDashboardAuthToken(req);
  if (token) dashboardSessions.delete(token);
  clearDashboardAuthCookie(res);
  res.json({ ok: true });
});
app.use("/datasets", requireDashboardAuth("page"), express.static(DATASETS_ROOT));
app.use("/sessions", requireDashboardAuth("page"), express.static(DATASETS_ROOT));
app.get("/dashboard", requireDashboardAuth("page"), (_req, res) => res.sendFile(path.join(process.cwd(), "dashboard", "dashboard.html")));
app.get("/dashboard/datasets", requireDashboardAuth("page"), (_req, res) => res.sendFile(path.join(process.cwd(), "dashboard", "datasets.html")));
app.get("/dashboard.js", requireDashboardAuth("page"), (_req, res) => res.sendFile(path.join(process.cwd(), "dashboard", "dashboard.js")));
app.get("/dashboard-datasets.js", requireDashboardAuth("page"), (_req, res) => res.sendFile(path.join(process.cwd(), "dashboard", "datasets.js")));
app.get("/layouts.js", requireDashboardAuth("page"), (_req, res) => res.sendFile(path.join(process.cwd(), "dashboard", "layouts.js")));
app.get("/store.js", requireDashboardAuth("page"), (_req, res) => res.sendFile(path.join(process.cwd(), "dashboard", "store.js")));
app.get("/widgets.js", requireDashboardAuth("page"), (_req, res) => res.sendFile(path.join(process.cwd(), "dashboard", "widgets.js")));
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
  const reconnectKey = sanitizeReconnectKey(req.body?.reconnect_key);
  if (!deviceName) return res.status(400).json({ ok: false, error: "device_name_required" });
  if (!joinCode) return res.status(400).json({ ok: false, error: "join_code_required" });
  if (joinCode !== sessionAuth.joinCode) return res.status(403).json({ ok: false, error: "invalid_join_code" });
  const deviceId = requestedDeviceId || `iphone-${crypto.randomBytes(3).toString("hex")}`;
  const joinToken = crypto.randomBytes(24).toString("hex");
  const expiresAtMs = Date.now() + PHONE_JOIN_TOKEN_TTL_MS;
  phoneAuthTokens.set(joinToken, {
    device_id: deviceId,
    device_name: deviceName,
    reconnect_key: reconnectKey,
    expires_at_ms: expiresAtMs
  });
  res.json({
    ok: true,
    join_token: joinToken,
    expires_at_ms: expiresAtMs,
    device_id: deviceId,
    device_name: deviceName,
    reconnect_key: reconnectKey || null
  });
});
app.get("/latest.jpg", requireDashboardAuth("api"), (req, res) => {
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

app.get("/api/datasets", requireDashboardAuth("api"), (_req, res) => {
  try {
    const sessions = listDatasetIds();
    res.json({
      sessions,
      summaries: sessions.map((id) => buildDatasetSummary(id)).filter(Boolean)
    });
  } catch {
    res.status(500).json({ sessions: [], summaries: [] });
  }
});
app.get("/api/storage", requireDashboardAuth("api"), (_req, res) => {
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
app.post("/api/datasets/:id/encode", requireDashboardAuth("api"), express.json(), async (req, res) => {
  const id = sanitizeSessionId(req.params.id);
  if (!id) return res.status(400).json({ error: "invalid id" });
  const root = path.join(DATASETS_ROOT, id);
  const deviceId = String(req.body?.device_id || "").trim();
  if (!deviceId) return res.status(400).json({ error: "device_id required" });
  const streamsDir = path.join(root, "devices", deviceId, "streams");
  const cameraDir = path.join(streamsDir, "camera");
  if (!fs.existsSync(cameraDir)) return res.status(404).json({ error: "camera frames not found" });
  const outMp4 = path.join(streamsDir, "camera_video.mp4");
  const timestampsPath = path.join(streamsDir, "camera_timestamps.csv");
  const fps = Math.max(1, Number(req.body?.fps || 10));
  const bitrate = String(req.body?.bitrate || "2M");
  const crf = Number.isFinite(req.body?.crf) ? Number(req.body.crf) : 23;
  const ffmpeg = process.env.FFMPEG_BIN || "ffmpeg";
  const result = await encodeCameraDirToMp4({ cameraDir, timestampsPath, outMp4, fps, bitrate, crf, ffmpegBin: ffmpeg });
  const logPath = path.join(root, "control_log.jsonl");
  appendControlLog(logPath, { type: "manual_encode", device_id: deviceId, at_iso: new Date().toISOString(), result });
  if (!result.ok) return res.status(500).json(result);
  res.json(result);
});
app.post("/api/datasets/:id/exports", requireDashboardAuth("api"), express.json(), async (req, res) => {
  const id = sanitizeSessionId(req.params.id);
  if (!id) return res.status(400).json({ error: "invalid id" });
  const root = path.join(DATASETS_ROOT, id);
  if (!fs.existsSync(root)) return res.status(404).json({ error: "not found" });
  const result = await exportSessionMedia({
    sessionDir: root,
    ffmpegBin: process.env.FFMPEG_BIN || "ffmpeg",
    audioDeviceId: typeof req.body?.audio_device_id === "string" ? req.body.audio_device_id : null,
    force: !!req.body?.force
  });
  appendControlLog(path.join(root, "control_log.jsonl"), {
    type: "session_export",
    mode: "manual",
    at_iso: new Date().toISOString(),
    result
  });
  if (!result.ok) return res.status(500).json(result);
  res.json(result);
});
app.patch("/api/datasets/:id", requireDashboardAuth("api"), express.json(), (req, res) => {
  const id = sanitizeSessionId(req.params.id);
  if (!id) return res.status(400).json({ error: "invalid id" });
  const root = path.join(DATASETS_ROOT, id);
  if (!fs.existsSync(root)) return res.status(404).json({ error: "not found" });
  const sessionName = String(req.body?.session_name || "").trim();
  if (!sessionName) return res.status(400).json({ error: "session_name required" });

  try {
    const activeSessionId = recording?.session_dir ? path.basename(String(recording.session_dir || "")) : "";
    if (recording?.active && activeSessionId === id) {
      return res.status(409).json({ error: "active session cannot be renamed" });
    }

    const nextId = makeSessionIdFromName(sessionName) || id;
    if (nextId !== id && fs.existsSync(path.join(DATASETS_ROOT, nextId))) {
      return res.status(409).json({ error: "session name already exists" });
    }

    let finalId = id;
    let finalRoot = root;
    if (nextId !== id) {
      finalRoot = path.join(DATASETS_ROOT, nextId);
      fs.renameSync(root, finalRoot);
      finalId = nextId;
    }

    const metaPath = path.join(finalRoot, "meta.json");
    const meta = safeReadJson(metaPath) || {};
    meta.session_name = sessionName;
    fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
    appendControlLog(path.join(finalRoot, "control_log.jsonl"), {
      type: "session_rename",
      at_iso: new Date().toISOString(),
      previous_id: id,
      session_id: finalId,
      session_name: sessionName
    });
    res.json({
      ok: true,
      id: finalId,
      previous_id: id,
      session_name: sessionName,
      renamed_folder: finalId !== id
    });
  } catch {
    res.status(500).json({ error: "rename failed" });
  }
});
app.delete("/api/datasets/:id", requireDashboardAuth("api"), (req, res) => {
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

app.get("/api/datasets/:id/manifest", requireDashboardAuth("api"), (req, res) => {
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
    sessionExports: {
      multiview: toUrlIfExists(
        path.join(root, EXPORTS_DIRNAME, SESSION_MULTIVIEW_NAME),
        `/datasets/${id}/${EXPORTS_DIRNAME}/${SESSION_MULTIVIEW_NAME}`
      ),
      multiviewWithAudio: toUrlIfExists(
        path.join(root, EXPORTS_DIRNAME, SESSION_MULTIVIEW_WITH_AUDIO_NAME),
        `/datasets/${id}/${EXPORTS_DIRNAME}/${SESSION_MULTIVIEW_WITH_AUDIO_NAME}`
      ),
      multiviewWithAudioAndGps: toUrlIfExists(
        path.join(root, EXPORTS_DIRNAME, SESSION_MULTIVIEW_WITH_AUDIO_AND_GPS_NAME),
        `/datasets/${id}/${EXPORTS_DIRNAME}/${SESSION_MULTIVIEW_WITH_AUDIO_AND_GPS_NAME}`
      ),
      manifestJson: toUrlIfExists(
        path.join(root, EXPORTS_DIRNAME, SESSION_MULTIVIEW_MANIFEST_NAME),
        `/datasets/${id}/${EXPORTS_DIRNAME}/${SESSION_MULTIVIEW_MANIFEST_NAME}`
      ),
      gpsPlaybackJson: toUrlIfExists(
        path.join(root, EXPORTS_DIRNAME, SESSION_GPS_PLAYBACK_NAME),
        `/datasets/${id}/${EXPORTS_DIRNAME}/${SESSION_GPS_PLAYBACK_NAME}`
      ),
      gpsPlaybackVideo: toUrlIfExists(
        path.join(root, EXPORTS_DIRNAME, SESSION_GPS_PLAYBACK_VIDEO_NAME),
        `/datasets/${id}/${EXPORTS_DIRNAME}/${SESSION_GPS_PLAYBACK_VIDEO_NAME}`
      )
    },
    imuCsv: toUrlIfExists(path.join(streamRoot, "imu.csv"), `/datasets/${id}/devices/${deviceId}/streams/imu.csv`),
    imuParquet: toUrlIfExists(path.join(streamRoot, "imu.parquet"), `/datasets/${id}/devices/${deviceId}/streams/imu.parquet`),
    audioCsv: toUrlIfExists(path.join(streamRoot, "audio.csv"), `/datasets/${id}/devices/${deviceId}/streams/audio.csv`),
    audioChunksCsv: toUrlIfExists(path.join(streamRoot, "audio_chunks.csv"), `/datasets/${id}/devices/${deviceId}/streams/audio_chunks.csv`),
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
    cameraChunksCsv: toUrlIfExists(
      path.join(streamRoot, "camera_chunks.csv"),
      `/datasets/${id}/devices/${deviceId}/streams/camera_chunks.csv`
    ),
    cameraVideo: toUrlIfExists(
      path.join(streamRoot, "camera_video.mp4"),
      `/datasets/${id}/devices/${deviceId}/streams/camera_video.mp4`
    ),
    cameraWithAudio: toUrlIfExists(
      path.join(streamRoot, CAMERA_WITH_AUDIO_NAME),
      `/datasets/${id}/devices/${deviceId}/streams/${CAMERA_WITH_AUDIO_NAME}`
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
const pendingBinaryHeadersBySocket = new Map(); // ws -> [header]
const dashboardSessions = new Map();
let fleetOverviewBroadcastTimer = null;
let fleetOverviewBroadcastDirty = false;
let lastFleetOverviewBroadcastAtMs = 0;
const fleetAlertDeliveries = new Map();

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
const workzoneAlertState = {
  sessionDir: null,
  devices: new Map()
};
const workzoneLiveState = {
  configured: shouldEnableWorkzoneLive(),
  proc: null,
  ready: false,
  failed: false,
  stdoutBuffer: "",
  busy: false,
  currentTask: null,
  pendingByDevice: new Map(),
  nextSeqByDevice: new Map(),
  lastStartAtMs: 0,
  lastReadyAtMs: 0,
  lastPongAtMs: 0,
  lastPingSentAtMs: 0,
  lastDispatchAtMs: 0,
  lastResultAtMs: 0,
  lastInferenceMs: 0,
  avgInferenceMs: 0,
  framesProcessed: 0,
  framesDropped: 0,
  restartCount: 0,
  restartTimer: null,
  lastExitCode: null,
  lastExitSignal: null,
  lastError: "",
  lastStatus: "idle",
  workerDevice: null,
  acceleratorKind: null,
  acceleratorIndex: null,
  acceleratorName: null,
  gpuUtilizationPct: null,
  gpuMemoryUsedMb: null,
  gpuMemoryTotalMb: null,
  gpuMemoryPct: null,
  lastTelemetryAtMs: 0,
  configPath: null,
  advancedMode: false,
  featureFlags: {},
  featureErrors: {}
};
let publicRuntimeInfo = loadPublicRuntimeInfo();

startWorkzoneLiveWorker();

wss.on("connection", (ws, req) => {
  connectionStats.sockets_connected += 1;
  console.log("[ws] socket connected", { sockets_connected: connectionStats.sockets_connected, sockets_closed: connectionStats.sockets_closed });
  ws.role = null;
  ws.device_id = null;
  ws.dashboardAuthorized = isDashboardRequestAuthorized(req);

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
    pendingBinaryHeadersBySocket.delete(ws);
    if (ws.role === "phone") {
      removeDeviceFromSession(ws.device_id, {
        expectedWs: ws,
        notify: false,
        removalReason: "offline_auto_kick"
      });
    }
    if (ws.role === "dashboard" && ws.client_id) {
      relayPreviewDisconnectToPhones(ws.client_id, "dashboard_disconnected");
    }
    dashboardSockets.delete(ws);
  });
});

// event loop lag tracking — measures how late each 1s tick fires
let _lastHealthTickMs = Date.now();
setInterval(() => {
  const now = Date.now();
  const lag = Math.max(0, now - _lastHealthTickMs - 1000);
  _lastHealthTickMs = now;
  const mem = process.memoryUsage();
  sessionManager.writeServerHealth({
    t_server_ms: now,
    event_loop_lag_ms: Math.round(lag),
    heap_used_mb: Number((mem.heapUsed / 1048576).toFixed(2)),
    heap_total_mb: Number((mem.heapTotal / 1048576).toFixed(2)),
  });
}, 1000);

setInterval(() => {
  pruneAuthRateLimit();
  prunePhoneAuthTokens();
  pruneFleetAlertDeliveries();
  publicRuntimeInfo = loadPublicRuntimeInfo();
  tickWorkzoneLiveHealth();
  refreshWorkzoneLiveDeviceStates();
  for (const [id, d] of devices.entries()) {
    const expectedImu = d.config.streams.imu.enabled ? d.config.streams.imu.rate_hz : 0;
    const expectedCam = getExpectedCameraIngressFps(d, { recordingActive: !!d.recordingStatus?.recording });
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
  pollWorkzoneAlerts();
}, WORKZONE_ALERT_POLL_INTERVAL_MS);

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

  if (msg.role === "dashboard") {
    if (DASHBOARD_AUTH_ENABLED && !ws.dashboardAuthorized) {
      sendWs(ws, { type: "auth_required", error: "dashboard_auth_required" }, { critical: true });
      try { ws.close(4401, "unauthorized"); } catch {}
      return;
    }
    ws.role = "dashboard";
    ws.client_id = `dash_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    connectionStats.dashboards_connected += 1;
    console.log("[ws] dashboard registered", {
      dashboards_connected: connectionStats.dashboards_connected,
      dashboards_disconnected: connectionStats.dashboards_disconnected
    });
    dashboardSockets.add(ws);
    sendWs(ws, { type: "hello_ack", role: "dashboard", client_id: ws.client_id }, { critical: true });
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

  ws.role = "phone";
  const authGrant = validatePhoneAuthGrant(msg.join_token);
  if (!authGrant) {
    sendWs(ws, { type: "auth_required", error: "invalid_or_expired_join_token" }, { critical: true });
    try { ws.close(4401, "unauthorized"); } catch {}
    return;
  }
  const requested = authGrant.device_id || String(msg.deviceId || msg.device_id || "").trim() || `iphone-${Math.random().toString(36).slice(2, 6)}`;
  const reconnectKey = sanitizeReconnectKey(msg.reconnect_key || authGrant.reconnect_key);
  const { assigned, reused, renamed } = resolvePhoneDeviceId({
    requested,
    reconnectKey,
    incomingWs: ws
  });
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
  existing.reconnect_key = reconnectKey || existing.reconnect_key || null;
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
    reused_device_id: !!reused,
    reconnect_key: existing.reconnect_key || null
  });
  console.log("[ws] phone registered", {
    requested,
    assigned: unique,
    device_name: existing.device_name,
    phones_connected: connectionStats.phones_connected,
    phones_disconnected: connectionStats.phones_disconnected
  });
  sendWs(ws, { type: "config", device_id: unique, runConfig: sessionConfig });
  sendWs(ws, { type: "recording_state", active: recording.active, session_id: recording.session_id || null });
  sendWs(ws, buildFleetOverviewPayload(), { critical: true });
  queueFleetOverviewBroadcast({ immediate: true });
  broadcastDeviceList();
  broadcastState();
}
function enqueuePendingBinaryHeader(ws, header) {
  if (!ws || !header || typeof header !== "object") return;
  const queue = pendingBinaryHeadersBySocket.get(ws) || [];
  queue.push(header);
  if (queue.length > 64) queue.shift();
  pendingBinaryHeadersBySocket.set(ws, queue);
}

function dequeuePendingBinaryHeader(ws) {
  const queue = pendingBinaryHeadersBySocket.get(ws);
  if (!queue?.length) return null;
  const header = queue.shift() || null;
  if (queue.length) pendingBinaryHeadersBySocket.set(ws, queue);
  else pendingBinaryHeadersBySocket.delete(ws);
  return header;
}

function handlePhoneJson(ws, msg) {
  const deviceId = ws.device_id;
  const d = devices.get(deviceId);
  if (!d) return;
  d.lastSeenTs = Date.now();

  if (msg.type === "fleet_alert_received") {
    const alertId = typeof msg.alert_id === "string" ? msg.alert_id.trim() : "";
    if (!alertId) return;
    ackFleetAlertDelivery(alertId, deviceId, {
      receivedAtMs: Date.now(),
      tDeviceMs: Number.isFinite(Number(msg.t_device_ms)) ? Number(msg.t_device_ms) : null
    });
    return;
  }

  if (msg.type === "fleet_alert") {
    const sourceDeviceName = d.device_name || deviceId;
    const kind = typeof msg.kind === "string" ? String(msg.kind).trim() : "";
    if (kind === "workzone_detected") {
      console.warn("[ws] ignored phone-generated workzone alert", {
        device_id: deviceId,
        source_device_name: sourceDeviceName
      });
      return;
    }
    const title = typeof msg.title === "string" ? String(msg.title).trim() : "";
    const message = typeof msg.message === "string" ? String(msg.message).trim() : "";
    const payload = {
      source_device_id: deviceId,
      source_device_name: sourceDeviceName
    };
    if (kind) payload.kind = kind.slice(0, 64);
    if (title) payload.title = title.slice(0, 120);
    if (message) payload.message = message.slice(0, 280);
    broadcastFleetAlert(payload, { critical: true });
    return;
  }

  if (msg.type === "webrtc_signal") {
    const dashboardId = String(msg.dashboard_id || "").trim();
    const signal = sanitizeWebRtcSignal(msg.signal);
    const dashboardWs = findDashboardSocketByClientId(dashboardId);
    if (!dashboardWs || !signal) return;
    sendWs(dashboardWs, {
      type: "webrtc_signal",
      dashboard_id: dashboardId,
      device_id: deviceId,
      signal
    }, { critical: true });
    return;
  }

  if (msg.type === "preview_status") {
    d.state.camera_preview = {
      live: !!msg.active,
      peer_count: Math.max(0, Math.min(8, Number(msg.peer_count || 0) || 0)),
      updated_at_ms: Date.now()
    };
    return;
  }

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
    if (!allowByRate(d, "camera", getExpectedCameraIngressFps(d, { recordingActive: !!d.recordingStatus?.recording }) || 10)) return;
    enqueuePendingBinaryHeader(ws, {
      type: "camera_header",
      device_id: deviceId,
      t_device_ms: Number(msg.t_device_ms || 0),
      format: msg.format || "jpeg",
      lighting_score: Number.isFinite(msg.lighting_score) ? Number(msg.lighting_score) : null,
      record_for_session: msg.record_for_session !== false
    });
    return;
  }

  if (msg.type === "camera_video_chunk_header") {
    enqueuePendingBinaryHeader(ws, {
      type: "camera_video_chunk_header",
      device_id: deviceId,
      t_device_ms: Number(msg.t_device_ms || 0),
      duration_ms: Number.isFinite(Number(msg.duration_ms)) ? Number(msg.duration_ms) : 0,
      chunk_index: Number.isFinite(Number(msg.chunk_index)) ? Number(msg.chunk_index) : 0,
      mime_type: typeof msg.mime_type === "string" ? msg.mime_type : "",
      capture_start_device_ms: Number.isFinite(Number(msg.capture_start_device_ms)) ? Number(msg.capture_start_device_ms) : null
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
      pcm_age_ms: Number.isFinite(msg.pcm_age_ms) ? Number(msg.pcm_age_ms) : null,
      audio_context_state: typeof msg.audio_context_state === "string" ? msg.audio_context_state : null,
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
    queueFleetOverviewBroadcast();
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
    const tRecvMs = Date.now();
    const tServerRxNs = nowServerRxNs();
    sessionManager.writeAudioPcm(deviceId, {
      pcmBuffer,
      t_recv_ms: tRecvMs,
      t_device_ms: Number(msg.t_device_ms || 0),
      t_server_rx_ns: tServerRxNs,
      sampleRate: Number(msg.sample_rate || 48000),
      channels: Number(msg.channels || 1),
      bitsPerSample: 16
    });
    markDeviceWrite(deviceId, tRecvMs);
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
    if (typeof msg.preview_active !== "undefined" || typeof msg.preview_peer_count !== "undefined") {
      d.state.camera_preview = {
        live: !!msg.preview_active,
        peer_count: Math.max(0, Math.min(8, Number(msg.preview_peer_count || 0) || 0)),
        updated_at_ms: Date.now()
      };
    }
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
  const header = dequeuePendingBinaryHeader(ws);
  if (!header) return;
  const tRecvMs = Date.now();
  const tServerRxNs = nowServerRxNs();
  const buffer = Buffer.from(data);

  if (header.type === "camera_video_chunk_header") {
    if (!recording.active) return;
    trackDeviceClockSample(d, Number(header.t_device_ms || 0), tRecvMs);
    sessionManager.writeCameraVideoChunk(ws.device_id, {
      chunkBuffer: buffer,
      t_device_ms: Number(header.t_device_ms || 0),
      duration_ms: Number(header.duration_ms || 0),
      chunk_index: Number(header.chunk_index || 0),
      mime_type: header.mime_type || "",
      capture_start_device_ms: Number.isFinite(header.capture_start_device_ms) ? Number(header.capture_start_device_ms) : null,
      t_recv_ms: tRecvMs,
      t_server_rx_ns: tServerRxNs
    });
    markDeviceWrite(ws.device_id, tRecvMs);
    return;
  }

  d.latestCameraBuffer = buffer;
  d.latestCameraMime = header.format === "jpeg" ? "image/jpeg" : "application/octet-stream";
  d.state.camera_latest_ts = tRecvMs;
  trackDeviceClockSample(d, Number(header.t_device_ms || 0), tRecvMs);
  if (Number.isFinite(header.lighting_score)) d.state.camera_quality.lighting_score = header.lighting_score;
  d.stats.camera_count += 1;
  if (recording.active && header.record_for_session !== false) {
    queueLiveWorkzoneFrame({
      deviceId: ws.device_id,
      jpegBuffer: d.latestCameraBuffer,
      tDeviceMs: header.t_device_ms,
      tRecvMs,
      format: header.format || "jpeg"
    });
  }
  if (recording.active && header.record_for_session !== false) {
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
  if (msg.type === "webrtc_signal") {
    const deviceId = sanitizeDeviceId(String(msg.device_id || "").trim());
    const signal = sanitizeWebRtcSignal(msg.signal);
    const d = devices.get(deviceId);
    if (!deviceId || !signal || !d?.connected || !isSocketOpen(d.ws)) return;
    sendWs(d.ws, {
      type: "webrtc_signal",
      dashboard_id: ws.client_id,
      device_id: deviceId,
      signal
    }, { critical: true });
    return;
  }

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
    applySessionConfigUpdate(incoming);
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
    applySessionConfigUpdate(msg.sessionConfig);
    return;
  }

  if (msg.type === "device_kick") {
    const deviceId = sanitizeDeviceId(String(msg.device_id || "").trim());
    if (!deviceId || !devices.has(deviceId)) return;
    kickDeviceFromDashboard(deviceId);
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
  clearQueuedWorkzoneLiveFrames();
  workzoneLiveState.nextSeqByDevice.clear();
  resetWorkzoneAlertState(res.sessionDir);
  resetAllDeviceWorkzoneLiveStates();

  for (const [id, d] of devices.entries()) {
    const targeted = recording.target_device_ids.includes(id);
    if (targeted) {
      d.recordingStatus.recording = false;
      d.recordingStatus.phase = "starting";
      d.recordingStatus.session_id = sid;
      d.recordingStatus.started_at_utc_ms = startedAt;
      d.recordingStatus.acknowledged_at_utc_ms = null;
      d.recordingStatus.modalities = emptyRecordingModalities();
      d.recordingStatus.writer = emptyRecordingWriter();
      d.recordingStatus.files = {};
      d.recordingStatus.error = null;
    }
  }

  broadcastState();
  broadcastDeviceList();
  broadcastRecordStatuses();
  for (const d of devices.values()) {
    if (d.connected && isSocketOpen(d.ws)) sendWs(d.ws, { type: "recording_state", active: true, session_id: sid });
  }
}

async function stopRecordingSession() {
  if (recording.phase === "STOPPING") return;
  if (!recording.active) return;

  recording.phase = "STOPPING";
  recording.stop_requested_at_ms = Date.now();
  const stoppingSessionId = recording.session_id;
  const stoppingTargets = [...recording.target_device_ids];
  for (const id of stoppingTargets) {
    const d = devices.get(id);
    if (!d?.recordingStatus) continue;
    d.recordingStatus.recording = false;
    d.recordingStatus.phase = "stopping";
  }
  broadcastState();
  broadcastRecordStatuses();
  for (const deviceId of stoppingTargets) {
    const d = devices.get(deviceId);
    if (d?.connected && isSocketOpen(d.ws)) {
      sendWs(d.ws, { type: "recording_state", active: false, session_id: stoppingSessionId, phase: "STOPPING" });
    }
  }
  const flushGraceMs = 1800;
  await new Promise((resolve) => setTimeout(resolve, flushGraceMs));
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
    finalize_tasks: finalizeTasks.length,
    flush_grace_ms: flushGraceMs
  });
  const exportTimeoutMs = 300000;
  let exportResult = null;
  try {
    exportResult = await Promise.race([
      exportSessionMedia({
        sessionDir: res.sessionDir,
        ffmpegBin: process.env.FFMPEG_BIN || "ffmpeg"
      }),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: `export timeout after ${exportTimeoutMs}ms` }), exportTimeoutMs))
    ]);
  } catch (err) {
    exportResult = { ok: false, error: String(err?.message || err) };
  }
  appendControlLog(path.join(res.sessionDir, "control_log.jsonl"), {
    type: "session_export",
    mode: "auto",
    at_iso: new Date().toISOString(),
    result: exportResult
  });

  for (const id of stoppingTargets) {
    const d = devices.get(id);
    if (!d) continue;
    d.recordingStatus.recording = false;
    d.recordingStatus.phase = "idle";
    d.recordingStatus.session_id = null;
    d.recordingStatus.started_at_utc_ms = null;
    d.recordingStatus.acknowledged_at_utc_ms = null;
    d.recordingStatus.modalities = emptyRecordingModalities();
    d.recordingStatus.files = collectStoppedFiles(res.sessionDir, id);
    d.recordingStatus.writer = {
      ...emptyRecordingWriter(d.stats?.dropped_packets || 0),
      last_write_utc_ms: d.recordingStatus.writer?.last_write_utc_ms || null
    };
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
  clearQueuedWorkzoneLiveFrames();
  workzoneLiveState.nextSeqByDevice.clear();
  resetWorkzoneAlertState(null);
  resetAllDeviceWorkzoneLiveStates();

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
  for (const d of devices.values()) {
    if (d.connected && isSocketOpen(d.ws)) sendWs(d.ws, { type: "recording_state", active: false, session_id: null });
  }
}

function broadcastRecordStatuses() {
  for (const [id, d] of devices.entries()) {
    refreshDeviceRecordingStatus(id, d);
    broadcastToDashboards(buildRecordStatusPayload(id, d));
  }
}

function refreshDeviceRecordingStatus(deviceId, d) {
  if (!d.recordingStatus) return;
  const writer = d.recordingStatus.writer || emptyRecordingWriter();
  writer.dropped = Number(d.stats?.dropped_packets || 0);
  d.recordingStatus.writer = writer;
  if (!d.recordingStatus.recording) return;
  const flags = sessionManager.getActiveRecorderFlags(deviceId);
  d.recordingStatus.modalities = {
    imu: !!flags.imu,
    cam: !!flags.camera,
    audio: !!(flags.audio || flags.audioWav),
    gps: !!flags.gps
  };
}

function buildRecordStatusPayload(deviceId, d) {
  return {
    type: "record_status",
    device_id: deviceId,
    connected: !!d.connected,
    recording: !!d.recordingStatus?.recording,
    phase: normalizeDeviceRecordingPhase(d.recordingStatus?.phase),
    session_id: d.recordingStatus?.session_id || null,
    started_at_utc_ms: d.recordingStatus?.started_at_utc_ms || null,
    acknowledged_at_utc_ms: d.recordingStatus?.acknowledged_at_utc_ms || null,
    modalities: d.recordingStatus?.modalities || emptyRecordingModalities(),
    writer: d.recordingStatus?.writer || emptyRecordingWriter()
  };
}

function markDeviceWrite(deviceId, tRecvMs) {
  const d = devices.get(deviceId);
  if (!d || !d.recordingStatus) return;
  if (!d.recordingStatus.writer) d.recordingStatus.writer = emptyRecordingWriter();
  const writeAtMs = Number(tRecvMs || Date.now());
  d.recordingStatus.writer.last_write_utc_ms = writeAtMs;
  if (
    recording.active &&
    d.recordingStatus.session_id &&
    recording.target_device_ids.includes(deviceId) &&
    d.recordingStatus.phase === "starting"
  ) {
    d.recordingStatus.recording = true;
    d.recordingStatus.phase = "recording";
    d.recordingStatus.acknowledged_at_utc_ms = writeAtMs;
  }
}

function emptyRecordingModalities() {
  return { imu: false, cam: false, audio: false, gps: false };
}

function emptyRecordingWriter(dropped = 0) {
  return { last_write_utc_ms: null, dropped: Number(dropped || 0) };
}

function emptyWorkzoneLivePublicState() {
  return {
    enabled: !!workzoneLiveState.configured,
    source: workzoneLiveState.configured ? "live" : null,
    status: workzoneLiveState.configured ? "idle" : "disabled",
    worker_state: workzoneLiveState.configured ? "starting" : "disabled",
    recording_active: false,
    pending: false,
    checking: false,
    active: false,
    banner_active: false,
    found: false,
    tracking: false,
    last_frame_at_ms: null,
    last_checked_at_ms: null,
    last_result_age_ms: null,
    last_frame_age_ms: null,
    queue_age_ms: null,
    frame_index: 0,
    score: 0,
    smoothed_score: 0,
    score_threshold: WORKZONE_LIVE_SCORE_THRESHOLD,
    max_confidence: 0,
    detection_count: 0,
    evidence_count: 0,
    class_counts: {},
    semantic_class_counts: {},
    class_summary: "",
    top_detections: [],
    advanced_mode: false,
    feature_flags: {},
    fused_state: "OUT",
    scene: "",
    scene_confidence: 0,
    clip_score: 0,
    clip_applied: false,
    ocr_text: "",
    ocr_confidence: 0,
    ocr_category: "NONE",
    ocr_boost: 0,
    orange_ratio: 0,
    context_score: 0,
    inference_ms: 0,
    inference_avg_ms: 0,
    pipeline_latency_ms: null,
    queue_wait_ms: null,
    dispatch_latency_ms: null,
    alert_latency_ms: null,
    result_to_alert_ms: null,
    positive_frames_recent: 0,
    strong_frames_recent: 0,
    consecutive_positive_frames: 0,
    consecutive_negative_frames: 0,
    frames_processed: 0,
    frames_dropped: 0,
    last_alert_at_ms: null,
    last_error: "",
    message: workzoneLiveState.configured ? "Waiting for recording to start." : "WorkZone live worker is disabled."
  };
}

function resetAllDeviceWorkzoneLiveStates() {
  for (const [, device] of devices.entries()) {
    device.state.workzone_live = emptyWorkzoneLivePublicState();
  }
}

function normalizeDeviceRecordingPhase(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "starting" || normalized === "recording" || normalized === "stopping") {
    return normalized;
  }
  return "idle";
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
    if (fs.existsSync(path.join(streamsDir, "camera_video.mp4"))) {
      out.cam = "camera_video.mp4";
    } else {
      const directSource = fs.readdirSync(streamsDir).find((name) => /^camera_video_source\./.test(name));
      if (directSource) out.cam = directSource;
      else if (fs.existsSync(path.join(streamsDir, "camera"))) out.cam = "camera/";
    }
    if (fs.existsSync(path.join(streamsDir, CAMERA_WITH_AUDIO_NAME))) out.cam_audio = CAMERA_WITH_AUDIO_NAME;
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
    runtime: buildRuntimeInfo(),
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
    camera_preview: d.state.camera_preview,
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
    workzone_live: d.state.workzone_live,
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
      cameraPreviewLive: !!d.state.camera_preview?.live,
      recordingActive: !!d.recordingStatus?.recording,
      recordingState: normalizeDeviceRecordingPhase(d.recordingStatus?.phase),
      recordingModalities: d.recordingStatus?.modalities || emptyRecordingModalities(),
      recordingSessionId: d.recordingStatus?.session_id || null,
      workzoneStatus: d.state.workzone_live?.status || "disabled",
      workzoneActive: !!d.state.workzone_live?.active,
      workzoneScore: Number(d.state.workzone_live?.score || 0),
      workzoneSmoothedScore: Number(d.state.workzone_live?.smoothed_score || 0),
      workzoneClassSummary: d.state.workzone_live?.class_summary || "",
      healthAlerts: computeDeviceAlerts(d),
      syncSummary: summarizeSyncStats(d)
    });
  }
  return out.sort((a, b) => a.device_id.localeCompare(b.device_id));
}

function getConfiguredPreviewCameraFps(config) {
  const fps = Number(config?.streams?.camera?.fps || 0);
  return fps > 0 ? fps : 0;
}

function getConfiguredRecordingCameraFps(config) {
  const previewFps = getConfiguredPreviewCameraFps(config);
  const camera = config?.streams?.camera || {};
  const requestedFps = Number(camera.video_fps || camera.fps || 0);
  if (camera.mode !== "stream" || !camera.record) return previewFps;
  return Math.max(previewFps, requestedFps > 0 ? requestedFps : previewFps);
}

function getExpectedCameraIngressFps(device, { recordingActive = false } = {}) {
  const config = device?.config || {};
  const camera = config?.streams?.camera || {};
  if (camera.mode !== "stream") return 0;
  const previewFps = getConfiguredPreviewCameraFps(config);
  const previewPeerCount = Math.max(0, Number(device?.state?.camera_preview?.peer_count || 0));
  const previewIngressFps = previewPeerCount > 0 ? 0 : previewFps;
  if (!recordingActive || !camera.record) return previewIngressFps;
  const recordMode = String(camera.record_mode || "both").toLowerCase();
  if (recordMode === "jpg" || recordMode === "both") {
    return Math.max(previewIngressFps, getConfiguredRecordingCameraFps(config));
  }
  return previewIngressFps;
}

function buildStreamStatus(config, d) {
  const s = config.streams;
  const now = Date.now();
  const cameraSeenMs = cameraActivityTsForDevice(d);
  const previewCameraFps = getConfiguredPreviewCameraFps(config);
  const recordCameraFps = getConfiguredRecordingCameraFps(config);
  return {
    imu: { enabled: !!s.imu.enabled, recording: !!s.imu.record, rate: `${s.imu.rate_hz} Hz`, last_seen_ms: d.state.imu_latest?.t_recv_ms || null },
    camera: {
      enabled: s.camera.mode !== "off",
      recording: !!s.camera.record && s.camera.mode === "stream",
      rate: s.camera.mode === "stream"
        ? (s.camera.record && recordCameraFps > previewCameraFps
          ? `${previewCameraFps} FPS preview / ${recordCameraFps} FPS recorded (${s.camera.record_mode || "both"})`
          : `${previewCameraFps} FPS (${s.camera.record_mode || "both"})`)
        : s.camera.mode,
      last_seen_ms: cameraSeenMs || null
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
  if (d.config.streams.camera.mode === "stream") enabled.push(cameraActivityTsForDevice(d) || 0);
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

function cameraActivityTsForDevice(d) {
  const previewTs = d?.state?.camera_preview?.live ? Number(d.state.camera_preview.updated_at_ms || 0) : 0;
  return Math.max(Number(d?.state?.camera_latest_ts || 0), previewTs) || 0;
}

function findDashboardSocketByClientId(clientId) {
  const targetId = String(clientId || "").trim();
  if (!targetId) return null;
  for (const ws of dashboardSockets) {
    if (ws.client_id === targetId && isSocketOpen(ws)) return ws;
  }
  return null;
}

function relayPreviewDisconnectToPhones(dashboardId, reason = "dashboard_disconnected") {
  const targetId = String(dashboardId || "").trim();
  if (!targetId) return;
  for (const [deviceId, d] of devices.entries()) {
    if (!d.connected || !isSocketOpen(d.ws)) continue;
    sendWs(d.ws, {
      type: "webrtc_signal",
      dashboard_id: targetId,
      device_id: deviceId,
      signal: { type: "disconnect", reason }
    }, { critical: true });
  }
}

function sanitizeWebRtcSignal(signal) {
  if (!signal || typeof signal !== "object") return null;
  const type = String(signal.type || "").trim();
  if (!["offer", "answer", "ice", "disconnect", "unavailable"].includes(type)) return null;
  const out = { type };
  if ((type === "offer" || type === "answer")) {
    if (typeof signal.sdp !== "string" || !signal.sdp.trim()) return null;
    out.sdp = signal.sdp;
  }
  if (type === "ice") {
    if (signal.candidate && typeof signal.candidate === "object") out.candidate = signal.candidate;
    else if (typeof signal.candidate === "string" && signal.candidate.trim()) out.candidate = { candidate: signal.candidate };
    else return null;
  }
  if (typeof signal.reason === "string" && signal.reason.trim()) {
    out.reason = signal.reason.trim().slice(0, 160);
  }
  return out;
}

function resolvePhoneDeviceId({ requested, reconnectKey, incomingWs }) {
  const byReconnectKey = reconnectKey ? findDeviceIdByReconnectKey(reconnectKey) : null;
  if (byReconnectKey) {
    const existingByKey = devices.get(byReconnectKey);
    if (existingByKey && (!existingByKey.connected || !isSocketOpen(existingByKey.ws) || existingByKey.ws === incomingWs)) {
      return { assigned: byReconnectKey, reused: true, renamed: byReconnectKey !== requested };
    }
    if (existingByKey) {
      const staleMs = Date.now() - Number(existingByKey.lastSeenTs || 0);
      if (staleMs > 7000) {
        try { existingByKey.ws?.close(4001, "replaced by reconnect"); } catch {}
        existingByKey.ws = null;
        existingByKey.connected = false;
        return { assigned: byReconnectKey, reused: true, renamed: byReconnectKey !== requested };
      }
    }
  }

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

function findDeviceIdByReconnectKey(reconnectKey) {
  const key = sanitizeReconnectKey(reconnectKey);
  if (!key) return null;
  for (const [deviceId, entry] of devices.entries()) {
    if (sanitizeReconnectKey(entry?.reconnect_key) === key) return deviceId;
  }
  return null;
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
    reconnect_key: null,
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
      camera_preview: { live: false, peer_count: 0, updated_at_ms: null },
      audio_latest: null,
      gps_latest: null,
      device_latest: null,
      camera_quality: { lighting_score: null },
      fusion: { connection_quality: 0, sensing_confidence: 0 },
      event_timeline: [],
      workzone_live: emptyWorkzoneLivePublicState()
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
      phase: "idle",
      session_id: null,
      started_at_utc_ms: null,
      acknowledged_at_utc_ms: null,
      modalities: emptyRecordingModalities(),
      writer: emptyRecordingWriter(),
      files: {},
      error: null
    }
  };
}

function firstConnectedDeviceId() {
  for (const [id, d] of devices.entries()) if (d.connected) return id;
  return null;
}

function maxWsBufferedBytes() {
  return (DEFAULT_RUN_CONFIG.performance?.max_ws_buffer_kb || 1024) * 1024;
}

function sendWsText(ws, text, opts = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const maxBufferedBytes = maxWsBufferedBytes();
  if (!opts.critical && ws.bufferedAmount > maxBufferedBytes) return;
  ws.send(text);
}

function sendWs(ws, payload, opts = {}) {
  sendWsText(ws, JSON.stringify(payload), opts);
}

function makeFleetAlertId(now = Date.now()) {
  return `alert_${now}_${Math.random().toString(36).slice(2, 10)}`;
}

function clearFleetAlertDeliveryTimer(record) {
  if (!record?.timer) return;
  clearTimeout(record.timer);
  record.timer = null;
}

function scheduleFleetAlertRetry(alertId, delayMs = FLEET_ALERT_ACK_TIMEOUT_MS) {
  const record = fleetAlertDeliveries.get(alertId);
  if (!record) return;
  clearFleetAlertDeliveryTimer(record);
  if (record.completedAtMs) return;
  record.timer = setTimeout(() => {
    const current = fleetAlertDeliveries.get(alertId);
    if (!current || current.completedAtMs) return;
    if (current.ackedDeviceIds.size >= current.targetDeviceIds.size) {
      current.completedAtMs = Date.now();
      return;
    }
    if (current.attempts >= FLEET_ALERT_MAX_RETRIES) {
      current.completedAtMs = Date.now();
      console.warn("[fleet-alert] delivery incomplete", {
        alert_id: alertId,
        kind: current.kind || "",
        missing_device_ids: [...current.targetDeviceIds].filter((deviceId) => !current.ackedDeviceIds.has(deviceId))
      });
      return;
    }
    current.attempts += 1;
    current.lastRetryAtMs = Date.now();
    let retryTargetCount = 0;
    for (const deviceId of current.targetDeviceIds) {
      if (current.ackedDeviceIds.has(deviceId)) continue;
      const target = devices.get(deviceId);
      if (!target?.connected || !isSocketOpen(target.ws)) continue;
      retryTargetCount += 1;
      sendWsText(target.ws, current.text, { critical: true });
    }
    if (retryTargetCount > 0) {
      console.warn("[fleet-alert] retrying delivery", {
        alert_id: alertId,
        kind: current.kind || "",
        attempt: current.attempts,
        target_count: retryTargetCount
      });
    }
    scheduleFleetAlertRetry(alertId, FLEET_ALERT_ACK_TIMEOUT_MS);
  }, Math.max(100, delayMs));
}

function pruneFleetAlertDeliveries(now = Date.now()) {
  for (const [alertId, record] of fleetAlertDeliveries.entries()) {
    const completedAtMs = Number(record?.completedAtMs || 0);
    const createdAtMs = Number(record?.createdAtMs || 0);
    const expired = completedAtMs > 0
      ? (now - completedAtMs) >= FLEET_ALERT_RETENTION_MS
      : (createdAtMs > 0 && (now - createdAtMs) >= (FLEET_ALERT_RETENTION_MS * 2));
    if (!expired) continue;
    clearFleetAlertDeliveryTimer(record);
    fleetAlertDeliveries.delete(alertId);
  }
}

function ackFleetAlertDelivery(alertId, deviceId, meta = {}) {
  const record = fleetAlertDeliveries.get(alertId);
  if (!record || !record.targetDeviceIds.has(deviceId)) return;
  record.ackedDeviceIds.add(deviceId);
  record.acks.set(deviceId, {
    received_at_ms: Number(meta?.receivedAtMs || Date.now()),
    t_device_ms: Number.isFinite(Number(meta?.tDeviceMs)) ? Number(meta.tDeviceMs) : null
  });
  if (record.ackedDeviceIds.size >= record.targetDeviceIds.size) {
    record.completedAtMs = Date.now();
    clearFleetAlertDeliveryTimer(record);
  }
}

function broadcastFleetAlert(payload, opts = {}) {
  const now = Number.isFinite(Number(payload?.t_server_ms)) && Number(payload.t_server_ms) > 0
    ? Number(payload.t_server_ms)
    : Date.now();
  const targetDeviceIds = [];
  for (const [deviceId, target] of devices.entries()) {
    if (!target.connected || !isSocketOpen(target.ws)) continue;
    targetDeviceIds.push(deviceId);
  }
  if (!targetDeviceIds.length) return 0;
  const alertId = typeof payload?.alert_id === "string" && payload.alert_id.trim()
    ? payload.alert_id.trim().slice(0, 120)
    : makeFleetAlertId(now);
  const message = {
    type: "fleet_alert",
    alert_id: alertId,
    t_server_ms: now,
    target_count: targetDeviceIds.length,
    target_device_ids: targetDeviceIds,
    ...payload
  };
  const text = JSON.stringify(message);
  for (const deviceId of targetDeviceIds) {
    const target = devices.get(deviceId);
    if (!target?.connected || !isSocketOpen(target.ws)) continue;
    sendWsText(target.ws, text, opts);
  }
  if (opts.trackDelivery !== false) {
    fleetAlertDeliveries.set(alertId, {
      alertId,
      kind: typeof message.kind === "string" ? message.kind : "",
      text,
      targetDeviceIds: new Set(targetDeviceIds),
      ackedDeviceIds: new Set(),
      acks: new Map(),
      attempts: 0,
      createdAtMs: now,
      completedAtMs: null,
      lastRetryAtMs: 0,
      timer: null
    });
    scheduleFleetAlertRetry(alertId, FLEET_ALERT_ACK_TIMEOUT_MS);
  }
  return targetDeviceIds.length;
}

function broadcastToDashboards(payload) {
  const text = JSON.stringify(payload);
  for (const ws of dashboardSockets) {
    sendWsText(ws, text);
  }
}

function broadcastToPhones(payload, opts = {}) {
  const text = JSON.stringify(payload);
  for (const [, device] of devices.entries()) {
    const ws = device?.ws;
    if (!device?.connected || !ws || ws.readyState !== WebSocket.OPEN) continue;
    sendWsText(ws, text, opts);
  }
}

function buildFleetOverviewPayload() {
  const devicesOverview = [];
  for (const [deviceId, device] of devices.entries()) {
    if (!device.connected) continue;
    devicesOverview.push({
      device_id: deviceId,
      device_name: device.device_name || deviceId,
      connected: true,
      recording: !!device.recordingStatus?.recording,
      motion_state: device.state?.motion_state || "UNKNOWN",
      camera_preview_live: !!device.state?.camera_preview?.live,
      workzone_active: !!device.state?.workzone_live?.active,
      workzone_found: !!device.state?.workzone_live?.found,
      workzone_tracking: !!device.state?.workzone_live?.tracking,
      workzone_status: String(device.state?.workzone_live?.status || "disabled"),
      workzone_fused_state: String(device.state?.workzone_live?.fused_state || "OUT"),
      workzone_score: Number(device.state?.workzone_live?.score || 0),
      workzone_score_threshold: Number(device.state?.workzone_live?.score_threshold || 0),
      workzone_max_confidence: Number(device.state?.workzone_live?.max_confidence || 0),
      workzone_detection_count: Math.max(0, Number(device.state?.workzone_live?.detection_count || 0)),
      workzone_class_summary: String(device.state?.workzone_live?.class_summary || ""),
      workzone_updated_at_ms: Number(device.state?.workzone_live?.last_checked_at_ms || 0),
      workzone_alert_latency_ms: Number(device.state?.workzone_live?.alert_latency_ms || 0),
      workzone_queue_wait_ms: Number(device.state?.workzone_live?.queue_wait_ms || 0),
      workzone_dispatch_latency_ms: Number(device.state?.workzone_live?.dispatch_latency_ms || 0),
      workzone_pipeline_latency_ms: Number(device.state?.workzone_live?.pipeline_latency_ms || 0),
      workzone_inference_ms: Number(device.state?.workzone_live?.inference_ms || 0),
      rtt_ms: Number(device.stats?.rtt_ms || 0),
      gps_latest: device.state?.gps_latest
        ? {
            t_recv_ms: Number(device.state.gps_latest.t_recv_ms || 0),
            lat: Number(device.state.gps_latest.lat || 0),
            lon: Number(device.state.gps_latest.lon || 0),
            accuracy_m: Number.isFinite(Number(device.state.gps_latest.accuracy_m)) ? Number(device.state.gps_latest.accuracy_m) : -1,
            speed_mps: Number.isFinite(Number(device.state.gps_latest.speed_mps)) ? Number(device.state.gps_latest.speed_mps) : -1,
            heading_deg: Number.isFinite(Number(device.state.gps_latest.heading_deg)) ? Number(device.state.gps_latest.heading_deg) : -1
          }
        : null
    });
  }
  devicesOverview.sort((a, b) => a.device_id.localeCompare(b.device_id));
  return {
    type: "fleet_overview",
    generated_at_ms: Date.now(),
    devices: devicesOverview
  };
}

function shouldEnableWorkzoneLive() {
  const enabledValues = new Set(["1", "true", "yes", "on"]);
  const disabledValues = new Set(["0", "false", "no", "off"]);
  if (enabledValues.has(WORKZONE_LIVE_ENABLE)) return true;
  if (disabledValues.has(WORKZONE_LIVE_ENABLE)) return false;
  return fs.existsSync(WORKZONE_LIVE_PYTHON)
    && fs.existsSync(WORKZONE_LIVE_PROJECT_DIR)
    && fs.existsSync(WORKZONE_LIVE_WORKER_SCRIPT);
}

function isWorkzoneLiveActive() {
  return !!workzoneLiveState.proc && !workzoneLiveState.failed;
}

function classifyWorkzoneLiveRuntimeStatus(now = Date.now()) {
  if (!workzoneLiveState.configured) return "disabled";
  if (workzoneLiveState.busy && workzoneLiveState.currentTask?.startedAtMs) {
    if ((now - workzoneLiveState.currentTask.startedAtMs) > WORKZONE_LIVE_BUSY_TIMEOUT_MS) return "stalled";
  }
  if (workzoneLiveState.proc && !workzoneLiveState.ready) return "starting";
  if (workzoneLiveState.failed && workzoneLiveState.restartTimer) return "restarting";
  if (!workzoneLiveState.proc) return workzoneLiveState.failed ? "offline" : "idle";
  if (!workzoneLiveState.ready) return "starting";
  if (
    recording.active
    && workzoneLiveState.lastResultAtMs
    && (now - workzoneLiveState.lastResultAtMs) > (WORKZONE_LIVE_RESULT_STALE_MS * 2)
  ) {
    return "stale";
  }
  if (workzoneLiveState.busy) return "checking";
  return "ready";
}

function buildWorkzoneLiveRuntimeInfo(now = Date.now()) {
  const status = classifyWorkzoneLiveRuntimeStatus(now);
  workzoneLiveState.lastStatus = status;
  const currentTask = workzoneLiveState.currentTask || null;
  const gpuUtilizationPct = Number.isFinite(Number(workzoneLiveState.gpuUtilizationPct))
    ? Number(workzoneLiveState.gpuUtilizationPct)
    : null;
  const gpuMemoryUsedMb = Number.isFinite(Number(workzoneLiveState.gpuMemoryUsedMb))
    ? Number(workzoneLiveState.gpuMemoryUsedMb)
    : null;
  const gpuMemoryTotalMb = Number.isFinite(Number(workzoneLiveState.gpuMemoryTotalMb))
    ? Number(workzoneLiveState.gpuMemoryTotalMb)
    : null;
  const gpuMemoryPct = Number.isFinite(Number(workzoneLiveState.gpuMemoryPct))
    ? Number(workzoneLiveState.gpuMemoryPct)
    : (
      gpuMemoryUsedMb !== null && gpuMemoryTotalMb !== null && gpuMemoryTotalMb > 0
        ? Number(((gpuMemoryUsedMb / gpuMemoryTotalMb) * 100).toFixed(1))
        : null
    );
  return {
    configured: !!workzoneLiveState.configured,
    enabled: !!workzoneLiveState.configured,
    status,
    ready: !!workzoneLiveState.ready,
    failed: !!workzoneLiveState.failed,
    busy: !!workzoneLiveState.busy,
    pid: Number.isFinite(Number(workzoneLiveState.proc?.pid)) ? Number(workzoneLiveState.proc.pid) : null,
    pending_frames: workzoneLiveState.pendingByDevice.size,
    last_start_at_ms: workzoneLiveState.lastStartAtMs || null,
    last_ready_at_ms: workzoneLiveState.lastReadyAtMs || null,
    last_pong_at_ms: workzoneLiveState.lastPongAtMs || null,
    last_result_at_ms: workzoneLiveState.lastResultAtMs || null,
    last_dispatch_at_ms: workzoneLiveState.lastDispatchAtMs || null,
    last_result_age_ms: workzoneLiveState.lastResultAtMs ? Math.max(0, now - workzoneLiveState.lastResultAtMs) : null,
    last_pong_age_ms: workzoneLiveState.lastPongAtMs ? Math.max(0, now - workzoneLiveState.lastPongAtMs) : null,
    current_device_id: currentTask?.deviceId || null,
    current_frame_index: Number.isFinite(Number(currentTask?.frameIndex)) ? Number(currentTask.frameIndex) : null,
    current_task_age_ms: currentTask?.startedAtMs ? Math.max(0, now - currentTask.startedAtMs) : null,
    frames_processed: Number(workzoneLiveState.framesProcessed || 0),
    frames_dropped: Number(workzoneLiveState.framesDropped || 0),
    last_inference_ms: Number.isFinite(Number(workzoneLiveState.lastInferenceMs)) ? Number(workzoneLiveState.lastInferenceMs) : null,
    avg_inference_ms: Number.isFinite(Number(workzoneLiveState.avgInferenceMs)) ? Number(workzoneLiveState.avgInferenceMs) : null,
    restart_count: Number(workzoneLiveState.restartCount || 0),
    last_exit_code: workzoneLiveState.lastExitCode,
    last_exit_signal: workzoneLiveState.lastExitSignal,
    last_error: workzoneLiveState.lastError || null,
    worker_device: workzoneLiveState.workerDevice || WORKZONE_LIVE_DEVICE,
    accelerator_kind: typeof workzoneLiveState.acceleratorKind === "string" ? workzoneLiveState.acceleratorKind : null,
    accelerator_index: Number.isFinite(Number(workzoneLiveState.acceleratorIndex)) ? Number(workzoneLiveState.acceleratorIndex) : null,
    accelerator_name: typeof workzoneLiveState.acceleratorName === "string" ? workzoneLiveState.acceleratorName : null,
    gpu_utilization_pct: gpuUtilizationPct,
    gpu_memory_used_mb: gpuMemoryUsedMb,
    gpu_memory_total_mb: gpuMemoryTotalMb,
    gpu_memory_pct: gpuMemoryPct,
    last_telemetry_at_ms: workzoneLiveState.lastTelemetryAtMs || null,
    telemetry_age_ms: workzoneLiveState.lastTelemetryAtMs ? Math.max(0, now - workzoneLiveState.lastTelemetryAtMs) : null,
    project_dir: WORKZONE_LIVE_PROJECT_DIR,
    config_path: workzoneLiveState.configPath || WORKZONE_LIVE_CONFIG_PATH || null,
    weights: WORKZONE_LIVE_WEIGHTS,
    device: WORKZONE_LIVE_DEVICE,
    imgsz: WORKZONE_LIVE_IMGSZ,
    conf: WORKZONE_LIVE_CONF,
    iou: WORKZONE_LIVE_IOU,
    score_threshold: WORKZONE_LIVE_SCORE_THRESHOLD,
    advanced_mode: !!workzoneLiveState.advancedMode,
    feature_flags: workzoneLiveState.featureFlags && typeof workzoneLiveState.featureFlags === "object"
      ? workzoneLiveState.featureFlags
      : {},
    feature_errors: workzoneLiveState.featureErrors && typeof workzoneLiveState.featureErrors === "object"
      ? workzoneLiveState.featureErrors
      : {},
    requested_overrides: {
      use_clip: WORKZONE_LIVE_USE_CLIP,
      enable_per_cue: WORKZONE_LIVE_ENABLE_PER_CUE,
      enable_context_boost: WORKZONE_LIVE_ENABLE_CONTEXT_BOOST,
      scene_context_enable: WORKZONE_LIVE_SCENE_CONTEXT_ENABLE,
      enable_ocr: WORKZONE_LIVE_ENABLE_OCR,
      ocr_full_frame: WORKZONE_LIVE_OCR_FULL_FRAME,
      ema_alpha: WORKZONE_LIVE_EMA_ALPHA || null,
      enter_th: WORKZONE_LIVE_ENTER_TH || null,
      exit_th: WORKZONE_LIVE_EXIT_TH || null,
      approach_th: WORKZONE_LIVE_APPROACH_TH || null,
      min_inside_frames: WORKZONE_LIVE_MIN_INSIDE_FRAMES || null,
      min_out_frames: WORKZONE_LIVE_MIN_OUT_FRAMES || null,
      clip_weight: WORKZONE_LIVE_CLIP_WEIGHT || null,
      clip_trigger_th: WORKZONE_LIVE_CLIP_TRIGGER_TH || null,
      per_cue_th: WORKZONE_LIVE_PER_CUE_TH || null,
      context_trigger_below: WORKZONE_LIVE_CONTEXT_TRIGGER_BELOW || null,
      orange_weight: WORKZONE_LIVE_ORANGE_WEIGHT || null,
      ocr_every_n: WORKZONE_LIVE_OCR_EVERY_N || null,
      ocr_threshold: WORKZONE_LIVE_OCR_THRESHOLD || null,
      scene_interval: WORKZONE_LIVE_SCENE_INTERVAL || null,
      clip_interval: WORKZONE_LIVE_CLIP_INTERVAL || null,
      per_cue_interval: WORKZONE_LIVE_PER_CUE_INTERVAL || null
    }
  };
}

function scheduleWorkzoneLiveRestart(reason = "retry") {
  if (!workzoneLiveState.configured || workzoneLiveState.restartTimer) return;
  if (
    !fs.existsSync(WORKZONE_LIVE_PYTHON)
    || !fs.existsSync(WORKZONE_LIVE_PROJECT_DIR)
    || !fs.existsSync(WORKZONE_LIVE_WORKER_SCRIPT)
  ) {
    return;
  }
  const delayMs = Math.min(10000, WORKZONE_LIVE_RESTART_DELAY_MS * Math.max(1, workzoneLiveState.restartCount + 1));
  workzoneLiveState.restartTimer = setTimeout(() => {
    workzoneLiveState.restartTimer = null;
    workzoneLiveState.restartCount += 1;
    startWorkzoneLiveWorker();
  }, delayMs);
  console.warn("[workzone-live] restart scheduled", { delay_ms: delayMs, reason });
}

function sendWorkzoneLiveMessage(payload) {
  const proc = workzoneLiveState.proc;
  if (!proc?.stdin || proc.stdin.destroyed) {
    workzoneLiveState.failed = true;
    workzoneLiveState.lastError = "worker stdin is unavailable";
    scheduleWorkzoneLiveRestart("stdin_unavailable");
    return false;
  }
  try {
    proc.stdin.write(`${JSON.stringify(payload)}\n`);
    return true;
  } catch (err) {
    workzoneLiveState.failed = true;
    workzoneLiveState.lastError = String(err?.message || err || "worker stdin write failed");
    console.error("[workzone-live] stdin write failed", err?.message || err);
    scheduleWorkzoneLiveRestart("stdin_write_failed");
    return false;
  }
}

function startWorkzoneLiveWorker() {
  if (!workzoneLiveState.configured || workzoneLiveState.proc) return;
  if (
    !fs.existsSync(WORKZONE_LIVE_PYTHON)
    || !fs.existsSync(WORKZONE_LIVE_PROJECT_DIR)
    || !fs.existsSync(WORKZONE_LIVE_WORKER_SCRIPT)
  ) {
    workzoneLiveState.failed = true;
    workzoneLiveState.lastError = "WorkZone live worker files are unavailable.";
    console.warn("[workzone-live] unavailable", {
      python: WORKZONE_LIVE_PYTHON,
      project_dir: WORKZONE_LIVE_PROJECT_DIR,
      worker_script: WORKZONE_LIVE_WORKER_SCRIPT
    });
    return;
  }

  const workerArgs = [
    WORKZONE_LIVE_WORKER_SCRIPT,
    "--workzone-project-dir", WORKZONE_LIVE_PROJECT_DIR,
    "--weights", WORKZONE_LIVE_WEIGHTS,
    "--device", WORKZONE_LIVE_DEVICE,
    "--imgsz", String(WORKZONE_LIVE_IMGSZ),
    "--conf", String(WORKZONE_LIVE_CONF),
    "--iou", String(WORKZONE_LIVE_IOU),
    "--score-threshold", String(WORKZONE_LIVE_SCORE_THRESHOLD),
    "--use-clip", WORKZONE_LIVE_USE_CLIP,
    "--enable-per-cue", WORKZONE_LIVE_ENABLE_PER_CUE,
    "--enable-context-boost", WORKZONE_LIVE_ENABLE_CONTEXT_BOOST,
    "--scene-context-enable", WORKZONE_LIVE_SCENE_CONTEXT_ENABLE,
    "--enable-ocr", WORKZONE_LIVE_ENABLE_OCR,
    "--ocr-full-frame", WORKZONE_LIVE_OCR_FULL_FRAME
  ];
  if (WORKZONE_LIVE_CONFIG_PATH) workerArgs.push("--config-path", WORKZONE_LIVE_CONFIG_PATH);
  if (WORKZONE_LIVE_EMA_ALPHA) workerArgs.push("--ema-alpha", WORKZONE_LIVE_EMA_ALPHA);
  if (WORKZONE_LIVE_ENTER_TH) workerArgs.push("--enter-th", WORKZONE_LIVE_ENTER_TH);
  if (WORKZONE_LIVE_EXIT_TH) workerArgs.push("--exit-th", WORKZONE_LIVE_EXIT_TH);
  if (WORKZONE_LIVE_APPROACH_TH) workerArgs.push("--approach-th", WORKZONE_LIVE_APPROACH_TH);
  if (WORKZONE_LIVE_MIN_INSIDE_FRAMES) workerArgs.push("--min-inside-frames", WORKZONE_LIVE_MIN_INSIDE_FRAMES);
  if (WORKZONE_LIVE_MIN_OUT_FRAMES) workerArgs.push("--min-out-frames", WORKZONE_LIVE_MIN_OUT_FRAMES);
  if (WORKZONE_LIVE_CLIP_WEIGHT) workerArgs.push("--clip-weight", WORKZONE_LIVE_CLIP_WEIGHT);
  if (WORKZONE_LIVE_CLIP_TRIGGER_TH) workerArgs.push("--clip-trigger-th", WORKZONE_LIVE_CLIP_TRIGGER_TH);
  if (WORKZONE_LIVE_PER_CUE_TH) workerArgs.push("--per-cue-th", WORKZONE_LIVE_PER_CUE_TH);
  if (WORKZONE_LIVE_CONTEXT_TRIGGER_BELOW) workerArgs.push("--context-trigger-below", WORKZONE_LIVE_CONTEXT_TRIGGER_BELOW);
  if (WORKZONE_LIVE_ORANGE_WEIGHT) workerArgs.push("--orange-weight", WORKZONE_LIVE_ORANGE_WEIGHT);
  if (WORKZONE_LIVE_OCR_EVERY_N) workerArgs.push("--ocr-every-n", WORKZONE_LIVE_OCR_EVERY_N);
  if (WORKZONE_LIVE_OCR_THRESHOLD) workerArgs.push("--ocr-threshold", WORKZONE_LIVE_OCR_THRESHOLD);
  if (WORKZONE_LIVE_SCENE_INTERVAL) workerArgs.push("--scene-interval", WORKZONE_LIVE_SCENE_INTERVAL);
  if (WORKZONE_LIVE_CLIP_INTERVAL) workerArgs.push("--clip-interval", WORKZONE_LIVE_CLIP_INTERVAL);
  if (WORKZONE_LIVE_PER_CUE_INTERVAL) workerArgs.push("--per-cue-interval", WORKZONE_LIVE_PER_CUE_INTERVAL);

  const proc = spawn(
    WORKZONE_LIVE_PYTHON,
    workerArgs,
    {
      cwd: process.cwd(),
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    }
  );

  workzoneLiveState.proc = proc;
  workzoneLiveState.ready = false;
  workzoneLiveState.failed = false;
  workzoneLiveState.stdoutBuffer = "";
  workzoneLiveState.busy = false;
  workzoneLiveState.currentTask = null;
  workzoneLiveState.lastStartAtMs = Date.now();
  workzoneLiveState.lastExitCode = null;
  workzoneLiveState.lastExitSignal = null;
  workzoneLiveState.lastError = "";
  workzoneLiveState.workerDevice = null;
  workzoneLiveState.acceleratorKind = null;
  workzoneLiveState.acceleratorIndex = null;
  workzoneLiveState.acceleratorName = null;
  workzoneLiveState.gpuUtilizationPct = null;
  workzoneLiveState.gpuMemoryUsedMb = null;
  workzoneLiveState.gpuMemoryTotalMb = null;
  workzoneLiveState.gpuMemoryPct = null;
  workzoneLiveState.lastTelemetryAtMs = 0;
  workzoneLiveState.configPath = null;
  workzoneLiveState.advancedMode = false;
  workzoneLiveState.featureFlags = {};
  workzoneLiveState.featureErrors = {};

  proc.stdout.on("data", (chunk) => {
    handleWorkzoneLiveStdoutChunk(chunk);
  });
  proc.stderr.on("data", (chunk) => {
    const text = String(chunk || "").trim();
    if (!text) return;
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) console.error(`[workzone-live] ${line.trim()}`);
    }
  });
  proc.on("error", (err) => {
    workzoneLiveState.failed = true;
    workzoneLiveState.lastError = String(err?.message || err || "worker process error");
    console.error("[workzone-live] process error", err?.message || err);
  });
  proc.on("exit", (code, signal) => {
    workzoneLiveState.ready = false;
    workzoneLiveState.failed = true;
    workzoneLiveState.proc = null;
    workzoneLiveState.busy = false;
    workzoneLiveState.currentTask = null;
    workzoneLiveState.stdoutBuffer = "";
    workzoneLiveState.lastExitCode = Number.isFinite(Number(code)) ? Number(code) : code;
    workzoneLiveState.lastExitSignal = signal || null;
    workzoneLiveState.lastError = signal
      ? `WorkZone worker exited with signal ${signal}`
      : `WorkZone worker exited with code ${code}`;
    clearQueuedWorkzoneLiveFrames({ countAsDropped: true });
    console.warn("[workzone-live] exited", { code, signal });
    scheduleWorkzoneLiveRestart("exit");
  });

  console.log("[workzone-live] starting", {
    python: WORKZONE_LIVE_PYTHON,
    project_dir: WORKZONE_LIVE_PROJECT_DIR,
    config_path: WORKZONE_LIVE_CONFIG_PATH || null,
    weights: WORKZONE_LIVE_WEIGHTS,
    device: WORKZONE_LIVE_DEVICE,
    imgsz: WORKZONE_LIVE_IMGSZ,
    use_clip: WORKZONE_LIVE_USE_CLIP,
    enable_per_cue: WORKZONE_LIVE_ENABLE_PER_CUE,
    enable_context_boost: WORKZONE_LIVE_ENABLE_CONTEXT_BOOST,
    scene_context_enable: WORKZONE_LIVE_SCENE_CONTEXT_ENABLE,
    enable_ocr: WORKZONE_LIVE_ENABLE_OCR,
    ocr_full_frame: WORKZONE_LIVE_OCR_FULL_FRAME
  });
}

function handleWorkzoneLiveStdoutChunk(chunk) {
  workzoneLiveState.stdoutBuffer += chunk.toString("utf8");
  while (true) {
    const newlineIndex = workzoneLiveState.stdoutBuffer.indexOf("\n");
    if (newlineIndex < 0) break;
    const line = workzoneLiveState.stdoutBuffer.slice(0, newlineIndex).trim();
    workzoneLiveState.stdoutBuffer = workzoneLiveState.stdoutBuffer.slice(newlineIndex + 1);
    if (!line) continue;
    let msg = null;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      console.warn("[workzone-live] invalid stdout", { line, error: err?.message || err });
      continue;
    }
    handleWorkzoneLiveMessage(msg);
  }
}

function updateWorkzoneLiveTelemetry(message) {
  if (!message || typeof message !== "object") return;
  let touched = false;

  const resolvedDevice = typeof message.resolved_device === "string" ? message.resolved_device.trim() : "";
  if (resolvedDevice) {
    workzoneLiveState.workerDevice = resolvedDevice;
    touched = true;
  } else if (typeof message.device === "string" && message.device.trim()) {
    workzoneLiveState.workerDevice = message.device.trim();
    touched = true;
  }

  if (typeof message.accelerator_kind === "string") {
    const value = message.accelerator_kind.trim().toLowerCase();
    workzoneLiveState.acceleratorKind = value || null;
    touched = true;
  }

  if (typeof message.accelerator_name === "string") {
    const value = message.accelerator_name.trim();
    workzoneLiveState.acceleratorName = value || null;
    touched = true;
  }

  if (Object.prototype.hasOwnProperty.call(message, "accelerator_index")) {
    workzoneLiveState.acceleratorIndex = Number.isFinite(Number(message.accelerator_index))
      ? Number(message.accelerator_index)
      : null;
    touched = true;
  }

  if (Object.prototype.hasOwnProperty.call(message, "gpu_utilization_pct")) {
    workzoneLiveState.gpuUtilizationPct = Number.isFinite(Number(message.gpu_utilization_pct))
      ? Number(message.gpu_utilization_pct)
      : null;
    touched = true;
  }

  if (Object.prototype.hasOwnProperty.call(message, "gpu_memory_used_mb")) {
    workzoneLiveState.gpuMemoryUsedMb = Number.isFinite(Number(message.gpu_memory_used_mb))
      ? Number(message.gpu_memory_used_mb)
      : null;
    touched = true;
  }

  if (Object.prototype.hasOwnProperty.call(message, "gpu_memory_total_mb")) {
    workzoneLiveState.gpuMemoryTotalMb = Number.isFinite(Number(message.gpu_memory_total_mb))
      ? Number(message.gpu_memory_total_mb)
      : null;
    touched = true;
  }

  if (Object.prototype.hasOwnProperty.call(message, "gpu_memory_pct")) {
    workzoneLiveState.gpuMemoryPct = Number.isFinite(Number(message.gpu_memory_pct))
      ? Number(message.gpu_memory_pct)
      : null;
    touched = true;
  } else if (
    Number.isFinite(Number(workzoneLiveState.gpuMemoryUsedMb))
    && Number.isFinite(Number(workzoneLiveState.gpuMemoryTotalMb))
    && Number(workzoneLiveState.gpuMemoryTotalMb) > 0
  ) {
    workzoneLiveState.gpuMemoryPct = Number(((Number(workzoneLiveState.gpuMemoryUsedMb) / Number(workzoneLiveState.gpuMemoryTotalMb)) * 100).toFixed(1));
    touched = true;
  }

  if (typeof message.config_path === "string") {
    const value = message.config_path.trim();
    workzoneLiveState.configPath = value || null;
  }

  if (Object.prototype.hasOwnProperty.call(message, "advanced_mode")) {
    workzoneLiveState.advancedMode = !!message.advanced_mode;
  }

  if (message.feature_flags && typeof message.feature_flags === "object") {
    workzoneLiveState.featureFlags = { ...message.feature_flags };
  }

  if (message.feature_errors && typeof message.feature_errors === "object") {
    workzoneLiveState.featureErrors = { ...message.feature_errors };
  }

  if (touched) {
    workzoneLiveState.lastTelemetryAtMs = Date.now();
  }
}

function handleWorkzoneLiveMessage(msg) {
  const type = String(msg?.type || "").trim();
  if (type === "ready") {
    workzoneLiveState.ready = true;
    workzoneLiveState.failed = false;
    workzoneLiveState.lastReadyAtMs = Date.now();
    workzoneLiveState.lastPongAtMs = Date.now();
    workzoneLiveState.lastError = "";
    updateWorkzoneLiveTelemetry(msg);
    console.log("[workzone-live] ready", {
      config_path: msg.config_path || null,
      weights: msg.weights || WORKZONE_LIVE_WEIGHTS,
      device: msg.device || WORKZONE_LIVE_DEVICE,
      imgsz: Number(msg.imgsz || WORKZONE_LIVE_IMGSZ),
      advanced_mode: !!msg.advanced_mode,
      feature_flags: msg.feature_flags && typeof msg.feature_flags === "object" ? msg.feature_flags : {},
      accelerator_kind: msg.accelerator_kind || null,
      accelerator_index: Number.isFinite(Number(msg.accelerator_index)) ? Number(msg.accelerator_index) : null,
      accelerator_name: msg.accelerator_name || null
    });
    dispatchNextWorkzoneLiveFrame();
    return;
  }
  if (type === "pong") {
    workzoneLiveState.lastPongAtMs = Date.now();
    workzoneLiveState.failed = false;
    updateWorkzoneLiveTelemetry(msg);
    return;
  }
  if (type === "error") {
    workzoneLiveState.lastError = String(msg?.error || msg?.stage || "worker error");
    console.warn("[workzone-live] worker error", msg);
    return;
  }
  if (type !== "result") return;
  workzoneLiveState.busy = false;
  workzoneLiveState.currentTask = null;
  const resultReceivedAtMs = Date.now();
  workzoneLiveState.lastResultAtMs = resultReceivedAtMs;
  workzoneLiveState.lastInferenceMs = Number.isFinite(Number(msg?.inference_ms)) ? Number(msg.inference_ms) : 0;
  updateWorkzoneLiveTelemetry(msg);
  if (workzoneLiveState.lastInferenceMs > 0) {
    workzoneLiveState.avgInferenceMs = workzoneLiveState.avgInferenceMs > 0
      ? Number(((workzoneLiveState.avgInferenceMs * 0.8) + (workzoneLiveState.lastInferenceMs * 0.2)).toFixed(2))
      : Number(workzoneLiveState.lastInferenceMs.toFixed(2));
  }
  workzoneLiveState.framesProcessed += 1;
  handleLiveWorkzoneResult({
    ...msg,
    result_received_at_ms: resultReceivedAtMs
  });
  dispatchNextWorkzoneLiveFrame();
}

function clearQueuedWorkzoneLiveFrames({ countAsDropped = false } = {}) {
  for (const [deviceId] of workzoneLiveState.pendingByDevice.entries()) {
    const device = devices.get(deviceId);
    if (!device?.state?.workzone_live) continue;
    device.state.workzone_live.pending = false;
    device.state.workzone_live.queue_age_ms = null;
    if (countAsDropped) {
      device.state.workzone_live.frames_dropped = Number(device.state.workzone_live.frames_dropped || 0) + 1;
    }
  }
  workzoneLiveState.pendingByDevice.clear();
}

function nextWorkzoneLiveSeq(deviceId) {
  const next = (workzoneLiveState.nextSeqByDevice.get(deviceId) || 0) + 1;
  workzoneLiveState.nextSeqByDevice.set(deviceId, next);
  return next;
}

function queueLiveWorkzoneFrame({ deviceId, jpegBuffer, tDeviceMs = 0, tRecvMs = Date.now(), format = "jpeg" }) {
  if (!isWorkzoneLiveActive()) return;
  if (!recording.active || !recording.session_dir) return;
  if (!recording.target_device_ids.includes(deviceId)) return;
  if (!jpegBuffer?.length || String(format || "jpeg").toLowerCase() !== "jpeg") return;

  const seq = nextWorkzoneLiveSeq(deviceId);
  const existing = workzoneLiveState.pendingByDevice.get(deviceId);
  if (existing) {
    workzoneLiveState.framesDropped += 1;
    const device = devices.get(deviceId);
    if (device?.state?.workzone_live) {
      device.state.workzone_live.frames_dropped = Number(device.state.workzone_live.frames_dropped || 0) + 1;
    }
  }
  workzoneLiveState.pendingByDevice.set(deviceId, {
    deviceId,
    sessionDir: recording.session_dir,
    seq,
    frameIndex: seq,
    jpegBuffer,
    tDeviceMs: Number(tDeviceMs || 0),
    tRecvMs: Number(tRecvMs || Date.now()),
    queuedAtMs: Date.now()
  });
  const device = devices.get(deviceId);
  if (device?.state?.workzone_live) {
    device.state.workzone_live.enabled = !!workzoneLiveState.configured;
    device.state.workzone_live.source = "live";
    device.state.workzone_live.recording_active = true;
    device.state.workzone_live.last_frame_at_ms = Number(tRecvMs || Date.now());
    device.state.workzone_live.pending = true;
    device.state.workzone_live.checking = false;
    device.state.workzone_live.queue_age_ms = 0;
    device.state.workzone_live.last_error = "";
  }
  dispatchNextWorkzoneLiveFrame();
}

function selectNextQueuedWorkzoneFrame() {
  let next = null;
  for (const pending of workzoneLiveState.pendingByDevice.values()) {
    if (!next || pending.queuedAtMs < next.queuedAtMs) next = pending;
  }
  return next;
}

function dispatchNextWorkzoneLiveFrame() {
  if (!isWorkzoneLiveActive() || !workzoneLiveState.ready || workzoneLiveState.busy) return;
  if (!recording.active || !recording.session_dir) {
    clearQueuedWorkzoneLiveFrames();
    return;
  }
  const next = selectNextQueuedWorkzoneFrame();
  if (!next) return;
  workzoneLiveState.pendingByDevice.delete(next.deviceId);
  const proc = workzoneLiveState.proc;
  if (!proc?.stdin || proc.stdin.destroyed) {
    workzoneLiveState.failed = true;
    workzoneLiveState.lastError = "worker stdin is unavailable";
    scheduleWorkzoneLiveRestart("dispatch_without_stdin");
    return;
  }
  workzoneLiveState.busy = true;
  workzoneLiveState.currentTask = {
    deviceId: next.deviceId,
    seq: next.seq,
    sessionDir: next.sessionDir,
    frameIndex: next.frameIndex,
    queuedAtMs: next.queuedAtMs,
    startedAtMs: Date.now(),
    tRecvMs: next.tRecvMs
  };
  workzoneLiveState.lastDispatchAtMs = workzoneLiveState.currentTask.startedAtMs;
  const payload = {
    type: "frame",
    device_id: next.deviceId,
    seq: next.seq,
    frame_index: next.frameIndex,
    session_dir: next.sessionDir,
    t_device_ms: next.tDeviceMs,
    t_recv_ms: next.tRecvMs,
    queued_at_ms: next.queuedAtMs,
    dispatch_started_at_ms: workzoneLiveState.currentTask.startedAtMs,
    jpeg_base64: next.jpegBuffer.toString("base64")
  };
  const device = devices.get(next.deviceId);
  if (device?.state?.workzone_live) {
    device.state.workzone_live.pending = false;
    device.state.workzone_live.checking = true;
    device.state.workzone_live.queue_age_ms = null;
  }
  if (!sendWorkzoneLiveMessage(payload)) {
    workzoneLiveState.busy = false;
    workzoneLiveState.currentTask = null;
  }
}

function sanitizeWorkzoneTopDetections(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      const label = String(entry?.label || "").trim();
      const confidence = Number(entry?.confidence || 0);
      if (!label || !Number.isFinite(confidence)) return null;
      return {
        label,
        confidence: Number(confidence.toFixed(4))
      };
    })
    .filter(Boolean)
    .slice(0, 5);
}

function normalizeLatencyTimestamp(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function computeLatencyDurationMs(startMs, endMs) {
  const start = normalizeLatencyTimestamp(startMs);
  const end = normalizeLatencyTimestamp(endMs);
  if (start === null || end === null || end < start) return null;
  return Math.max(0, Math.round(end - start));
}

function buildWorkzoneAlertLatency({ deviceId = "", rawResult = null, alertSentAtMs = Date.now() } = {}) {
  const frameReceivedAtMs = normalizeLatencyTimestamp(rawResult?.t_recv_ms);
  const queuedAtMs = normalizeLatencyTimestamp(rawResult?.queued_at_ms);
  const dispatchStartedAtMs = normalizeLatencyTimestamp(rawResult?.dispatch_started_at_ms);
  const resultReceivedAtMs = normalizeLatencyTimestamp(rawResult?.result_received_at_ms);
  const inferenceMs = Number.isFinite(Number(rawResult?.inference_ms))
    ? Number(Number(rawResult.inference_ms).toFixed(2))
    : null;
  const sourceRttMs = Number.isFinite(Number(devices.get(deviceId)?.stats?.rtt_ms))
    ? Number(Number(devices.get(deviceId).stats.rtt_ms).toFixed(1))
    : null;
  return {
    frame_received_at_ms: frameReceivedAtMs,
    queued_at_ms: queuedAtMs,
    dispatch_started_at_ms: dispatchStartedAtMs,
    result_received_at_ms: resultReceivedAtMs,
    alert_sent_at_ms: normalizeLatencyTimestamp(alertSentAtMs),
    queue_wait_ms: computeLatencyDurationMs(queuedAtMs, dispatchStartedAtMs),
    dispatch_to_result_ms: computeLatencyDurationMs(dispatchStartedAtMs, resultReceivedAtMs),
    frame_to_result_ms: computeLatencyDurationMs(frameReceivedAtMs, resultReceivedAtMs),
    result_to_alert_ms: computeLatencyDurationMs(resultReceivedAtMs, alertSentAtMs),
    frame_to_alert_ms: computeLatencyDurationMs(frameReceivedAtMs, alertSentAtMs),
    inference_ms: inferenceMs,
    source_rtt_ms: sourceRttMs
  };
}

function createWorkzoneAlertDeviceState() {
  return {
    active: false,
    lastAlertAtMs: 0,
    lastAlertFrameIndex: 0,
    lastPositiveAtMs: 0,
    smoothedScore: 0,
    stickyUntilMs: 0,
    consecutivePositiveFrames: 0,
    consecutiveNegativeFrames: 0,
    history: []
  };
}

function ensureWorkzoneAlertDeviceState(deviceId) {
  const existing = workzoneAlertState.devices.get(deviceId);
  if (existing) return existing;
  const next = createWorkzoneAlertDeviceState();
  workzoneAlertState.devices.set(deviceId, next);
  return next;
}

function resolveWorkzoneDeviceStatus(publicState, now = Date.now()) {
  if (!publicState?.enabled) return "disabled";
  if (!publicState.recording_active) return "idle";
  const workerState = String(publicState.worker_state || "");
  if (["starting", "restarting", "offline", "stalled"].includes(workerState)) return workerState;
  if (publicState.last_error) return "error";
  if (publicState.active && publicState.last_checked_at_ms && (now - publicState.last_checked_at_ms) <= WORKZONE_LIVE_RESULT_STALE_MS) return "detected";
  if (publicState.tracking && publicState.last_checked_at_ms && (now - publicState.last_checked_at_ms) <= WORKZONE_LIVE_RESULT_STALE_MS) return "tracking";
  if (publicState.checking) return "checking";
  if (publicState.pending) return "queued";
  if (publicState.last_checked_at_ms && (now - publicState.last_checked_at_ms) > WORKZONE_LIVE_RESULT_STALE_MS) return "stale";
  return "waiting";
}

function resolveWorkzoneDeviceMessage(publicState, now = Date.now()) {
  const status = resolveWorkzoneDeviceStatus(publicState, now);
  if (status === "disabled") return "WorkZone live worker is disabled.";
  if (status === "idle") return "Start recording to enable WorkZone live checks.";
  if (status === "starting") return "Starting WorkZone live worker.";
  if (status === "restarting") return "Restarting WorkZone live worker.";
  if (status === "offline") return publicState.last_error || "WorkZone live worker is offline.";
  if (status === "stalled") return publicState.last_error || "WorkZone live worker is stalled.";
  if (status === "error") return publicState.last_error || "Latest WorkZone check failed.";
  if (status === "detected") {
    return publicState.class_summary
      ? `Detected ${publicState.class_summary}.`
      : "WorkZone detected.";
  }
  if (status === "tracking") {
    return publicState.class_summary
      ? `Tracking ${publicState.class_summary}.`
      : "Tracking low-confidence WorkZone evidence.";
  }
  if (status === "checking") return "Checking newest camera frame.";
  if (status === "queued") return "Newest camera frame queued for WorkZone.";
  if (status === "stale") return "WorkZone results are stale.";
  if (publicState?.source === "file") return "Waiting for WorkZone status updates.";
  return "Waiting for live camera frames.";
}

function refreshWorkzoneLiveDeviceStates(now = Date.now()) {
  const runtimeStatus = classifyWorkzoneLiveRuntimeStatus(now);
  for (const [deviceId, device] of devices.entries()) {
    const publicState = device.state.workzone_live || emptyWorkzoneLivePublicState();
    const alertState = workzoneAlertState.devices.get(deviceId);
    const pending = workzoneLiveState.pendingByDevice.get(deviceId) || null;
    publicState.enabled = publicState.source === "file" ? true : !!workzoneLiveState.configured;
    publicState.recording_active = !!(recording.active && recording.target_device_ids.includes(deviceId));
    publicState.worker_state = publicState.source === "file" ? "file" : runtimeStatus;
    publicState.pending = !!pending;
    publicState.checking = !!(workzoneLiveState.busy && workzoneLiveState.currentTask?.deviceId === deviceId);
    publicState.queue_age_ms = pending ? Math.max(0, now - pending.queuedAtMs) : null;
    publicState.last_result_age_ms = publicState.last_checked_at_ms ? Math.max(0, now - publicState.last_checked_at_ms) : null;
    publicState.last_frame_age_ms = publicState.last_frame_at_ms ? Math.max(0, now - publicState.last_frame_at_ms) : null;
    if (alertState) {
      publicState.active = !!alertState.active;
      publicState.banner_active = !!alertState.active || (alertState.lastAlertAtMs && (now - alertState.lastAlertAtMs) <= WORKZONE_LIVE_ALERT_BANNER_MS);
      publicState.last_alert_at_ms = alertState.lastAlertAtMs || publicState.last_alert_at_ms || null;
      publicState.smoothed_score = Number((alertState.smoothedScore || publicState.smoothed_score || 0).toFixed(3));
      publicState.consecutive_positive_frames = Number(alertState.consecutivePositiveFrames || 0);
      publicState.consecutive_negative_frames = Number(alertState.consecutiveNegativeFrames || 0);
    } else {
      publicState.active = false;
      publicState.banner_active = false;
    }
    publicState.status = resolveWorkzoneDeviceStatus(publicState, now);
    publicState.message = resolveWorkzoneDeviceMessage(publicState, now);
    device.state.workzone_live = publicState;
  }
}

function tickWorkzoneLiveHealth() {
  const now = Date.now();
  workzoneLiveState.lastStatus = classifyWorkzoneLiveRuntimeStatus(now);
  if (workzoneLiveState.proc && workzoneLiveState.ready && !workzoneLiveState.busy) {
    if ((now - workzoneLiveState.lastPingSentAtMs) >= WORKZONE_LIVE_PING_INTERVAL_MS) {
      if (sendWorkzoneLiveMessage({ type: "ping" })) {
        workzoneLiveState.lastPingSentAtMs = now;
      }
    }
  }
  if (
    workzoneLiveState.busy
    && workzoneLiveState.currentTask?.startedAtMs
    && (now - workzoneLiveState.currentTask.startedAtMs) > WORKZONE_LIVE_BUSY_TIMEOUT_MS
  ) {
    workzoneLiveState.lastError = `WorkZone worker stalled for more than ${WORKZONE_LIVE_BUSY_TIMEOUT_MS}ms`;
    console.error("[workzone-live] worker timeout", {
      device_id: workzoneLiveState.currentTask.deviceId,
      frame_index: workzoneLiveState.currentTask.frameIndex,
      busy_timeout_ms: WORKZONE_LIVE_BUSY_TIMEOUT_MS
    });
    try { workzoneLiveState.proc?.kill(); } catch {}
  }
  if (!workzoneLiveState.proc && workzoneLiveState.configured && workzoneLiveState.failed && !workzoneLiveState.restartTimer) {
    scheduleWorkzoneLiveRestart("health_tick");
  }
}

function updateWorkzoneDetectionState({
  deviceId,
  info,
  payload,
  source = "live",
  statusPath = null,
  rawResult = null
}) {
  const device = devices.get(deviceId);
  if (!device) return;
  const now = Date.now();
  const score = Number(info?.score || 0);
  const maxConfidence = Number(info?.max_confidence || 0);
  const detectionCount = Math.max(0, Number(info?.detection_count || 0));
  const evidenceCount = Math.max(detectionCount, Math.max(0, Number(info?.evidence_count || rawResult?.evidence_count || 0)));
  const frameIndex = Math.max(0, Number(info?.frame_index || 0));
  const scoreThreshold = Number.isFinite(Number(payload?.score_threshold))
    ? Number(payload.score_threshold)
    : WORKZONE_LIVE_SCORE_THRESHOLD;
  const updatedAtMs = Date.parse(String(info?.updated_at || payload?.updated_at || ""));
  const checkedAtMs = Number.isFinite(updatedAtMs) ? updatedAtMs : now;
  const topDetections = sanitizeWorkzoneTopDetections(rawResult?.top_detections);
  const rawPositive = isWorkzoneDetectionActive(info, payload, now);
  const alertState = ensureWorkzoneAlertDeviceState(deviceId);
  const publicState = device.state.workzone_live || emptyWorkzoneLivePublicState();
  const previousStatus = String(publicState.status || "");
  const previousFound = !!publicState.found;
  const previousTracking = !!publicState.tracking;
  const previousActive = !!publicState.active;
  const queueWaitMs = computeLatencyDurationMs(rawResult?.queued_at_ms, rawResult?.dispatch_started_at_ms);
  const dispatchLatencyMs = computeLatencyDurationMs(rawResult?.dispatch_started_at_ms, rawResult?.result_received_at_ms);

  if (!alertState.lastPositiveAtMs || (now - alertState.lastPositiveAtMs) > (WORKZONE_LIVE_EVIDENCE_WINDOW_MS * 2)) {
    alertState.smoothedScore = score;
  } else {
    alertState.smoothedScore = (alertState.smoothedScore * 0.58) + (score * 0.42);
  }
  alertState.history.push({
    ts: now,
    positive: rawPositive,
    score,
    maxConfidence,
    detectionCount
  });
  while (alertState.history.length && (now - alertState.history[0].ts) > WORKZONE_LIVE_EVIDENCE_WINDOW_MS) {
    alertState.history.shift();
  }

  if (rawPositive) {
    alertState.lastPositiveAtMs = now;
    alertState.consecutivePositiveFrames += 1;
    alertState.consecutiveNegativeFrames = 0;
  } else {
    alertState.consecutivePositiveFrames = 0;
    alertState.consecutiveNegativeFrames += 1;
  }

  const positiveFramesRecent = alertState.history.filter((entry) => entry.positive).length;
  const strongFramesRecent = alertState.history.filter((entry) => entry.positive && (
    entry.score >= (scoreThreshold + 0.12)
    || entry.maxConfidence >= 0.6
  )).length;
  const trackingFramesRecent = alertState.history.filter((entry) => (
    entry.detectionCount > 0 || entry.score >= (scoreThreshold * 0.55)
  )).length;
  const wasActive = !!alertState.active;
  const shouldActivate = (
    rawPositive && (
      strongFramesRecent >= 1
      || positiveFramesRecent >= WORKZONE_LIVE_MIN_POSITIVE_FRAMES
      || alertState.consecutivePositiveFrames >= WORKZONE_LIVE_MIN_POSITIVE_FRAMES
    )
  ) || (
    !rawPositive
    && positiveFramesRecent >= 2
    && alertState.smoothedScore >= (scoreThreshold * 0.95)
    && trackingFramesRecent >= 2
  );
  if (shouldActivate) {
    alertState.active = true;
    alertState.stickyUntilMs = now + WORKZONE_LIVE_ACTIVE_HOLD_MS;
  } else if (alertState.active) {
    const keepActive = (
      now <= Number(alertState.stickyUntilMs || 0)
      || (alertState.lastPositiveAtMs && (now - alertState.lastPositiveAtMs) <= WORKZONE_LIVE_ACTIVE_HOLD_MS)
      || positiveFramesRecent >= 2
    );
    alertState.active = !!keepActive;
  }

  let alertSent = false;
  let alertLatency = null;
  if (
    alertState.active
    && !wasActive
    && (now - alertState.lastAlertAtMs) >= WORKZONE_ALERT_COOLDOWN_MS
  ) {
    const alertOutcome = sendWorkzoneDetectedAlert({
      deviceId,
      info,
      payload,
      statusPath,
      rawResult
    });
    if (alertOutcome.targetCount > 0) {
      alertState.lastAlertAtMs = now;
      alertState.lastAlertFrameIndex = frameIndex;
      alertLatency = alertOutcome.latency;
      alertSent = true;
    }
  }

  publicState.enabled = true;
  publicState.source = source;
  publicState.recording_active = !!(recording.active && recording.target_device_ids.includes(deviceId));
  publicState.pending = false;
  publicState.checking = false;
  publicState.worker_state = source === "file" ? "file" : classifyWorkzoneLiveRuntimeStatus(now);
  publicState.found = rawPositive;
  publicState.tracking = alertState.active || trackingFramesRecent > 0;
  publicState.active = !!alertState.active;
  publicState.banner_active = !!alertState.active || (alertState.lastAlertAtMs && (now - alertState.lastAlertAtMs) <= WORKZONE_LIVE_ALERT_BANNER_MS);
  publicState.last_checked_at_ms = checkedAtMs;
  publicState.last_result_age_ms = Math.max(0, now - checkedAtMs);
  publicState.frame_index = frameIndex;
  publicState.score = Number(score.toFixed(3));
  publicState.smoothed_score = Number(alertState.smoothedScore.toFixed(3));
  publicState.score_threshold = Number(scoreThreshold.toFixed(3));
  publicState.max_confidence = Number(maxConfidence.toFixed(3));
  publicState.detection_count = detectionCount;
  publicState.evidence_count = evidenceCount;
  publicState.class_counts = info?.class_counts && typeof info.class_counts === "object" ? info.class_counts : {};
  publicState.semantic_class_counts = rawResult?.semantic_class_counts && typeof rawResult.semantic_class_counts === "object"
    ? rawResult.semantic_class_counts
    : {};
  publicState.class_summary = summarizeWorkzoneClasses(publicState.class_counts);
  publicState.top_detections = topDetections;
  publicState.advanced_mode = !!(rawResult?.advanced_mode || workzoneLiveState.advancedMode);
  publicState.feature_flags = workzoneLiveState.featureFlags && typeof workzoneLiveState.featureFlags === "object"
    ? workzoneLiveState.featureFlags
    : {};
  publicState.fused_state = typeof rawResult?.state === "string" ? rawResult.state : "OUT";
  publicState.scene = typeof rawResult?.scene === "string" ? rawResult.scene : "";
  publicState.scene_confidence = Number.isFinite(Number(rawResult?.scene_confidence)) ? Number(Number(rawResult.scene_confidence).toFixed(3)) : 0;
  publicState.clip_score = Number.isFinite(Number(rawResult?.clip_score)) ? Number(Number(rawResult.clip_score).toFixed(3)) : 0;
  publicState.clip_applied = !!rawResult?.clip_applied;
  publicState.ocr_text = typeof rawResult?.ocr_text === "string" ? rawResult.ocr_text : "";
  publicState.ocr_confidence = Number.isFinite(Number(rawResult?.ocr_confidence)) ? Number(Number(rawResult.ocr_confidence).toFixed(3)) : 0;
  publicState.ocr_category = typeof rawResult?.ocr_category === "string" ? rawResult.ocr_category : "NONE";
  publicState.ocr_boost = Number.isFinite(Number(rawResult?.ocr_boost)) ? Number(Number(rawResult.ocr_boost).toFixed(3)) : 0;
  publicState.orange_ratio = Number.isFinite(Number(rawResult?.orange_ratio)) ? Number(Number(rawResult.orange_ratio).toFixed(3)) : 0;
  publicState.context_score = Number.isFinite(Number(rawResult?.context_score)) ? Number(Number(rawResult.context_score).toFixed(3)) : 0;
  publicState.inference_ms = Number(Number(rawResult?.inference_ms || 0).toFixed(2));
  publicState.inference_avg_ms = Number(Number(workzoneLiveState.avgInferenceMs || publicState.inference_avg_ms || 0).toFixed(2));
  publicState.pipeline_latency_ms = Number.isFinite(Number(rawResult?.t_recv_ms))
    ? Math.max(0, now - Number(rawResult.t_recv_ms))
    : publicState.pipeline_latency_ms;
  publicState.queue_wait_ms = queueWaitMs;
  publicState.dispatch_latency_ms = dispatchLatencyMs;
  publicState.positive_frames_recent = positiveFramesRecent;
  publicState.strong_frames_recent = strongFramesRecent;
  publicState.consecutive_positive_frames = Number(alertState.consecutivePositiveFrames || 0);
  publicState.consecutive_negative_frames = Number(alertState.consecutiveNegativeFrames || 0);
  publicState.frames_processed = Number(publicState.frames_processed || 0) + 1;
  publicState.frames_dropped = Number(publicState.frames_dropped || 0);
  publicState.last_alert_at_ms = alertState.lastAlertAtMs || publicState.last_alert_at_ms || null;
  publicState.alert_latency_ms = Number.isFinite(Number(alertLatency?.frame_to_alert_ms))
    ? Number(alertLatency.frame_to_alert_ms)
    : publicState.alert_latency_ms;
  publicState.result_to_alert_ms = Number.isFinite(Number(alertLatency?.result_to_alert_ms))
    ? Number(alertLatency.result_to_alert_ms)
    : publicState.result_to_alert_ms;
  publicState.last_error = rawResult?.status && rawResult.status !== "ok"
    ? String(rawResult?.error || rawResult.status || "workzone result error")
    : "";
  publicState.status = resolveWorkzoneDeviceStatus(publicState, now);
  publicState.message = resolveWorkzoneDeviceMessage(publicState, now);

  if (!alertSent && source === "live" && rawResult?.status && rawResult.status !== "ok") {
    publicState.status = "error";
    publicState.message = resolveWorkzoneDeviceMessage(publicState, now);
  }

  device.state.workzone_live = publicState;
  const urgentBroadcast = alertSent
    || previousStatus !== publicState.status
    || previousFound !== publicState.found
    || previousTracking !== publicState.tracking
    || previousActive !== publicState.active;
  queueFleetOverviewBroadcast({ immediate: urgentBroadcast });
  if (urgentBroadcast) broadcastState();
}

function handleLiveWorkzoneResult(result) {
  if (!recording.active || !recording.session_dir) return;
  const sessionDir = String(result?.session_dir || "").trim();
  if (sessionDir && sessionDir !== recording.session_dir) return;
  const deviceId = sanitizeDeviceId(String(result?.device_id || "").trim());
  if (!deviceId) return;
  if (workzoneAlertState.sessionDir !== recording.session_dir) {
    resetWorkzoneAlertState(recording.session_dir);
  }

  const info = {
    found: !!result?.found,
    score: Number(result?.score || 0),
    max_confidence: Number(result?.max_confidence || 0),
    detection_count: Math.max(0, Number(result?.detection_count || 0)),
    evidence_count: Math.max(0, Number(result?.evidence_count || 0)),
    class_counts: result?.class_counts && typeof result.class_counts === "object" ? result.class_counts : {},
    top_detections: sanitizeWorkzoneTopDetections(result?.top_detections),
    state: typeof result?.state === "string" ? result.state : "OUT",
    frame_index: Math.max(0, Number(result?.frame_index || result?.seq || 0)),
    frame_filename: "",
    updated_at: String(result?.updated_at || new Date().toISOString())
  };
  const payload = {
    score_threshold: Number.isFinite(Number(result?.score_threshold))
      ? Number(result.score_threshold)
      : WORKZONE_LIVE_SCORE_THRESHOLD,
    updated_at: info.updated_at,
    output_root: null
  };
  updateWorkzoneDetectionState({
    deviceId,
    info,
    payload,
    source: "live",
    statusPath: null,
    rawResult: result
  });
}

function resetWorkzoneAlertState(sessionDir = null) {
  workzoneAlertState.sessionDir = sessionDir || null;
  workzoneAlertState.devices.clear();
}

function pollWorkzoneAlerts() {
  if (isWorkzoneLiveActive()) return;
  const sessionDir = recording.active ? recording.session_dir : null;
  if (!sessionDir) {
    if (workzoneAlertState.sessionDir) resetWorkzoneAlertState(null);
    return;
  }
  if (workzoneAlertState.sessionDir !== sessionDir) {
    resetWorkzoneAlertState(sessionDir);
  }
  const statusPath = resolveWorkzoneStatusPath(sessionDir);
  if (!statusPath) return;

  let payload = null;
  try {
    payload = JSON.parse(fs.readFileSync(statusPath, "utf8"));
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object") return;

  const entries = payload.devices && typeof payload.devices === "object" ? Object.entries(payload.devices) : [];
  const seen = new Set();
  for (const [deviceId, rawInfo] of entries) {
    seen.add(deviceId);
    const info = rawInfo && typeof rawInfo === "object" ? rawInfo : {};
    updateWorkzoneDetectionState({
      deviceId,
      info,
      payload,
      source: "file",
      statusPath,
      rawResult: null
    });
  }

  for (const [deviceId] of workzoneAlertState.devices.entries()) {
    if (!seen.has(deviceId)) workzoneAlertState.devices.delete(deviceId);
  }
}

function resolveWorkzoneStatusPath(sessionDir) {
  if (!sessionDir) return null;
  const candidates = [
    path.join(sessionDir, "outputs", "workzone", "session_status.json"),
    path.join(sessionDir, "workzone", "session_status.json")
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function isWorkzoneDetectionActive(info, payload, now = Date.now()) {
  if (!info || typeof info !== "object") return false;
  const found = !!info.found;
  const detectionCount = Math.max(0, Number(info.detection_count || 0));
  const evidenceCount = Math.max(detectionCount, Math.max(0, Number(info.evidence_count || 0)));
  const score = Number(info.score || 0);
  const fusedState = typeof info.state === "string" ? info.state.trim().toUpperCase() : "";
  const payloadThreshold = Number.isFinite(Number(payload?.score_threshold))
    ? Number(payload.score_threshold)
    : 0.45;
  const updatedAtMs = Date.parse(String(info.updated_at || payload?.updated_at || ""));
  if (Number.isFinite(updatedAtMs) && (now - updatedAtMs) > WORKZONE_ALERT_STALE_MS) return false;
  return found && (evidenceCount > 0 || (fusedState && fusedState !== "OUT")) && score >= payloadThreshold;
}

function sendWorkzoneDetectedAlert({ deviceId, info, payload, statusPath, rawResult = null }) {
  const sourceDeviceName = devices.get(deviceId)?.device_name || deviceId;
  const rawGps = devices.get(deviceId)?.state?.gps_latest;
  const sourceGps = (rawGps
    && Number.isFinite(Number(rawGps.lat)) && Math.abs(Number(rawGps.lat)) > 0.0001
    && Number.isFinite(Number(rawGps.lon)) && Math.abs(Number(rawGps.lon)) > 0.0001
    && Math.abs(Number(rawGps.lat)) <= 90 && Math.abs(Number(rawGps.lon)) <= 180
    && (Date.now() - Number(rawGps.t_recv_ms || 0)) < 30000)
    ? { lat: Number(rawGps.lat), lon: Number(rawGps.lon), t_recv_ms: Number(rawGps.t_recv_ms || 0) }
    : null;
  const score = Number(info.score || 0);
  const maxConfidence = Number(info.max_confidence || 0);
  const detectionCount = Math.max(0, Number(info.detection_count || 0));
  const frameIndex = Math.max(0, Number(info.frame_index || 0));
  const classCounts = info.class_counts && typeof info.class_counts === "object" ? info.class_counts : {};
  const classSummary = summarizeWorkzoneClasses(classCounts);
  const topDetections = sanitizeWorkzoneTopDetections(info.top_detections);
  const alertSentAtMs = Date.now();
  const latency = buildWorkzoneAlertLatency({
    deviceId,
    rawResult,
    alertSentAtMs
  });
  const message = classSummary
    ? `Workzone detected by ${sourceDeviceName} with ${detectionCount} detection${detectionCount === 1 ? "" : "s"} (${classSummary}).`
    : `Workzone detected by ${sourceDeviceName} with ${detectionCount} detection${detectionCount === 1 ? "" : "s"}.`;
  const targetCount = broadcastFleetAlert({
    t_server_ms: alertSentAtMs,
    kind: "workzone_detected",
    title: "Workzone detected",
    message,
    source_device_id: deviceId,
    source_device_name: sourceDeviceName,
    workzone: {
      device_id: deviceId,
      frame_index: frameIndex,
      state: typeof info.state === "string" ? info.state : (typeof rawResult?.state === "string" ? rawResult.state : "OUT"),
      frame_filename: typeof info.frame_filename === "string" ? info.frame_filename : "",
      score,
      score_threshold: Number.isFinite(Number(payload?.score_threshold)) ? Number(payload.score_threshold) : WORKZONE_LIVE_SCORE_THRESHOLD,
      max_confidence: maxConfidence,
      detection_count: detectionCount,
      class_counts: classCounts,
      class_summary: classSummary,
      top_detections: topDetections,
      session_dir: recording.session_dir || null,
      status_path: statusPath,
      output_root: typeof payload?.output_root === "string" ? payload.output_root : null,
      updated_at: typeof info.updated_at === "string" ? info.updated_at : (typeof payload?.updated_at === "string" ? payload.updated_at : null),
      inference_ms: Number.isFinite(Number(rawResult?.inference_ms)) ? Number(Number(rawResult.inference_ms).toFixed(2)) : null,
      latency,
      source_gps: sourceGps
    }
  }, { critical: true });
  if (targetCount > 0) {
    console.log("[workzone] fleet alert sent", {
      source_device_id: deviceId,
      source_device_name: sourceDeviceName,
      target_count: targetCount,
      frame_index: frameIndex,
      frame_filename: typeof info.frame_filename === "string" ? info.frame_filename : "",
      score: Number(score.toFixed(3)),
      max_confidence: Number(maxConfidence.toFixed(3)),
      detection_count: detectionCount,
      classes: classCounts,
      latency
    });
    appendControlLog(path.join(recording.session_dir, "control_log.jsonl"), {
      type: "workzone_alert_sent",
      at_iso: new Date().toISOString(),
      source_device_id: deviceId,
      source_device_name: sourceDeviceName,
      target_count: targetCount,
      frame_index: frameIndex,
      frame_filename: typeof info.frame_filename === "string" ? info.frame_filename : "",
      score,
      max_confidence: maxConfidence,
      detection_count: detectionCount,
      class_counts: classCounts,
      latency
    });
  }
  return { targetCount, latency };
}

function summarizeWorkzoneClasses(classCounts) {
  const items = Object.entries(classCounts || {})
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]) || String(a[0]).localeCompare(String(b[0])))
    .slice(0, 3)
    .map(([label, count]) => `${label} x${Number(count)}`);
  return items.join(", ");
}

function flushFleetOverviewBroadcast() {
  fleetOverviewBroadcastTimer = null;
  if (!fleetOverviewBroadcastDirty) return;
  fleetOverviewBroadcastDirty = false;
  lastFleetOverviewBroadcastAtMs = Date.now();
  broadcastToPhones(buildFleetOverviewPayload());
}

function queueFleetOverviewBroadcast({ immediate = false } = {}) {
  fleetOverviewBroadcastDirty = true;
  const now = Date.now();
  const delay = immediate
    ? 0
    : Math.max(0, FLEET_OVERVIEW_BROADCAST_MIN_INTERVAL_MS - (now - lastFleetOverviewBroadcastAtMs));
  if (fleetOverviewBroadcastTimer && delay > 0) return;
  if (fleetOverviewBroadcastTimer) {
    clearTimeout(fleetOverviewBroadcastTimer);
    fleetOverviewBroadcastTimer = null;
  }
  if (delay === 0) {
    flushFleetOverviewBroadcast();
    return;
  }
  fleetOverviewBroadcastTimer = setTimeout(flushFleetOverviewBroadcast, delay);
}

function buildSessionConfigPayload() {
  return {
    type: "session_config",
    sessionConfig,
    sessionState: recording.active ? "active" : "draft",
    joinCode: sessionAuth.joinCode
  };
}

function buildRuntimeInfo() {
  const info = {
    server_started_at_ms: SERVER_STARTED_AT_MS,
    server_uptime_sec: Math.max(0, Math.floor((Date.now() - SERVER_STARTED_AT_MS) / 1000)),
    public_started_at_ms: null,
    public_uptime_sec: null,
    public_url: null,
    public_mode: null,
    workzone_live: buildWorkzoneLiveRuntimeInfo()
  };
  const publicStart = Number(publicRuntimeInfo?.started_at_ms || 0);
  if (publicStart > 0) {
    info.public_started_at_ms = publicStart;
    info.public_uptime_sec = Math.max(0, Math.floor((Date.now() - publicStart) / 1000));
    info.public_url = typeof publicRuntimeInfo?.public_url === "string" ? publicRuntimeInfo.public_url : null;
    info.public_mode = typeof publicRuntimeInfo?.mode === "string" ? publicRuntimeInfo.mode : "public";
  }
  return info;
}

function requireDashboardAuth(mode = "api") {
  return (req, res, next) => {
    if (!DASHBOARD_AUTH_ENABLED) return next();
    if (isDashboardRequestAuthorized(req)) return next();
    if (mode === "page") {
      return res.redirect(302, `/dashboard/login?next=${encodeURIComponent(req.originalUrl || "/dashboard")}`);
    }
    res.status(401).json({ ok: false, error: "dashboard_auth_required" });
  };
}

function verifyDashboardPassword(password) {
  const input = Buffer.from(String(password || ""), "utf8");
  const expected = Buffer.from(DASHBOARD_PASSWORD, "utf8");
  if (input.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(input, expected);
  } catch {
    return false;
  }
}

function createDashboardSession() {
  pruneDashboardSessions();
  const token = crypto.randomBytes(32).toString("hex");
  dashboardSessions.set(token, { expires_at_ms: Date.now() + DASHBOARD_SESSION_TTL_MS });
  return token;
}

function pruneDashboardSessions() {
  const now = Date.now();
  for (const [token, session] of dashboardSessions.entries()) {
    if (!session || Number(session.expires_at_ms || 0) <= now) {
      dashboardSessions.delete(token);
    }
  }
}

function parseCookies(req) {
  const raw = String(req?.headers?.cookie || "");
  const out = {};
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
  }
  return out;
}

function getDashboardAuthToken(req) {
  const cookies = parseCookies(req);
  const token = cookies[DASHBOARD_AUTH_COOKIE];
  return typeof token === "string" && token ? token : null;
}

function isDashboardRequestAuthorized(req) {
  if (!DASHBOARD_AUTH_ENABLED) return true;
  pruneDashboardSessions();
  const token = getDashboardAuthToken(req);
  if (!token) return false;
  const session = dashboardSessions.get(token);
  if (!session) return false;
  if (Number(session.expires_at_ms || 0) <= Date.now()) {
    dashboardSessions.delete(token);
    return false;
  }
  session.expires_at_ms = Date.now() + DASHBOARD_SESSION_TTL_MS;
  dashboardSessions.set(token, session);
  return true;
}

function setDashboardAuthCookie(res, token) {
  const parts = [
    `${DASHBOARD_AUTH_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(DASHBOARD_SESSION_TTL_MS / 1000)}`
  ];
  if (useHttps) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearDashboardAuthCookie(res) {
  const parts = [
    `${DASHBOARD_AUTH_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0"
  ];
  if (useHttps) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function getDashboardRedirectTarget(raw) {
  const target = typeof raw === "string" ? raw : "/dashboard";
  if (!target.startsWith("/")) return "/dashboard";
  if (target.startsWith("//")) return "/dashboard";
  return target;
}

function buildDashboardLoginPage(nextPath) {
  const escapedNext = JSON.stringify(nextPath);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>D3C / Login</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      min-height: 100vh;
      font-family: "Inter", -apple-system, "Segoe UI", system-ui, sans-serif;
      font-size: 14px;
      color: #b0c3db;
      background-color: #060919;
      background-image: radial-gradient(ellipse 900px 480px at 50% 0%, rgba(68, 120, 245, 0.09) 0%, transparent 65%);
      display: grid;
      place-items: center;
      padding: 24px;
      -webkit-font-smoothing: antialiased;
    }

    .card {
      width: min(100%, 380px);
      background: #0c1424;
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 12px;
      padding: 32px 28px;
    }

    h1 {
      font-size: 1.25rem;
      font-weight: 600;
      color: #b0c3db;
      margin-bottom: 4px;
    }

    .subtitle {
      font-size: 13px;
      color: #42566e;
      margin-bottom: 28px;
      line-height: 1.5;
    }

    form { display: grid; gap: 12px; }

    label {
      display: grid;
      gap: 6px;
      font-size: 13px;
      font-weight: 500;
      color: #b0c3db;
    }

    input {
      width: 100%;
      height: 42px;
      border: 1px solid rgba(255, 255, 255, 0.10);
      border-radius: 7px;
      padding: 0 12px;
      font-size: 14px;
      font-family: inherit;
      color: #b0c3db;
      background: #101c33;
      outline: none;
      transition: border-color 140ms;
    }

    input:focus { border-color: rgba(68, 120, 245, 0.5); }

    button {
      width: 100%;
      height: 42px;
      border: 1px solid #4478f5;
      border-radius: 7px;
      font-size: 14px;
      font-weight: 600;
      font-family: inherit;
      color: #fff;
      background: #4478f5;
      cursor: pointer;
      transition: background 140ms, border-color 140ms;
    }

    button:hover { background: #3366e8; border-color: #3366e8; }

    .status {
      min-height: 18px;
      font-size: 12px;
      color: #e85252;
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>D3C Dashboard</h1>
    <p class="subtitle">Enter your password to continue</p>
    <form id="loginForm">
      <label for="passwordInput">Password
        <input id="passwordInput" type="password" autocomplete="current-password" />
      </label>
      <button type="submit">Sign in</button>
      <div id="loginStatus" class="status"></div>
    </form>
  </main>
  <script>
    const nextPath = ${escapedNext};
    const form = document.getElementById("loginForm");
    const passwordInput = document.getElementById("passwordInput");
    const loginStatus = document.getElementById("loginStatus");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      loginStatus.textContent = "Signing in...";
      try {
        const res = await fetch("/api/dashboard/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: passwordInput.value })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
          loginStatus.textContent = "Invalid password";
          return;
        }
        location.assign(nextPath);
      } catch {
        loginStatus.textContent = "Login failed";
      }
    });
    passwordInput.focus();
  </script>
</body>
</html>`;
}

function createJoinCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function getDeployId() {
  try {
    const stat = fs.statSync(__filename);
    return `${stat.size}-${Math.round(stat.mtimeMs)}`;
  } catch {
    return null;
  }
}

function loadAuthState() {
  const currentDeployId = getDeployId();
  try {
    if (fs.existsSync(AUTH_STATE_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(AUTH_STATE_PATH, "utf8"));
      const joinCode = normalizeJoinCode(parsed?.joinCode);
      if (joinCode && parsed?.deployId === currentDeployId) {
        return { joinCode, updated_at_ms: Number(parsed?.updated_at_ms || Date.now()), deployId: currentDeployId };
      }
    }
  } catch {}
  const state = { joinCode: createJoinCode(), updated_at_ms: Date.now(), deployId: currentDeployId };
  persistAuthState(state);
  return state;
}

function persistAuthState(state) {
  try {
    fs.mkdirSync(path.dirname(AUTH_STATE_PATH), { recursive: true });
    fs.writeFileSync(AUTH_STATE_PATH, JSON.stringify({
      joinCode: normalizeJoinCode(state?.joinCode),
      updated_at_ms: Number(state?.updated_at_ms || Date.now()),
      deployId: state?.deployId || null
    }, null, 2), "utf8");
  } catch {}
}

function loadPublicRuntimeInfo() {
  if (!PUBLIC_RUNTIME_STATE_PATH) return null;
  try {
    if (!fs.existsSync(PUBLIC_RUNTIME_STATE_PATH)) return null;
    const parsed = JSON.parse(fs.readFileSync(PUBLIC_RUNTIME_STATE_PATH, "utf8"));
    const startedAtMs = Number(parsed?.started_at_ms || 0);
    if (!startedAtMs || startedAtMs <= 0) return null;
    return {
      started_at_ms: startedAtMs,
      public_url: typeof parsed?.public_url === "string" ? parsed.public_url : null,
      mode: typeof parsed?.mode === "string" ? parsed.mode : "public"
    };
  } catch {
    return null;
  }
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

function revokePhoneAuthTokensForDevice(deviceId) {
  const targetId = sanitizeDeviceId(deviceId);
  if (!targetId) return;
  for (const [token, grant] of phoneAuthTokens.entries()) {
    if (sanitizeDeviceId(grant?.device_id) === targetId) {
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

function removeDeviceFromSession(deviceId, {
  expectedWs = null,
  notify = false,
  removalReason = "removed_by_dashboard",
  disconnectReason = "removed_by_dashboard",
  disconnectMessage = "Dashboard removed this phone from the session. Tap Start Device to join again."
} = {}) {
  const targetId = sanitizeDeviceId(deviceId);
  if (!targetId) return false;
  const entry = devices.get(targetId);
  if (!entry) return false;
  if (expectedWs && entry.ws !== expectedWs) return false;

  revokePhoneAuthTokensForDevice(targetId);
  const targetWasFocused = focusedDeviceId === targetId;
  const targetWasRecording = (recording.target_device_ids || []).includes(targetId);
  const targetWs = entry.ws;
  recording.target_device_ids = (recording.target_device_ids || []).filter((id) => id !== targetId);
  workzoneLiveState.pendingByDevice.delete(targetId);
  workzoneLiveState.nextSeqByDevice.delete(targetId);
  workzoneAlertState.devices.delete(targetId);
  if (notify && targetWs && isSocketOpen(targetWs)) {
    sendWs(targetWs, {
      type: "force_disconnect",
      reason: disconnectReason,
      message: disconnectMessage
    }, { critical: true });
    setTimeout(() => {
      try { targetWs.close(4002, disconnectReason); } catch {}
    }, 80);
  }

  devices.delete(targetId);
  if (targetWasFocused) {
    focusedDeviceId = firstConnectedDeviceId() || null;
  }
  console.log("[device] removed", {
    device_id: targetId,
    reason: removalReason,
    connected: !!entry.connected,
    recording_targeted: targetWasRecording
  });
  broadcastDeviceList();
  queueFleetOverviewBroadcast({ immediate: true });
  broadcastState();
  broadcastRecordStatuses();
  return true;
}

function kickDeviceFromDashboard(deviceId) {
  return removeDeviceFromSession(deviceId, {
    notify: true,
    removalReason: "removed_by_dashboard",
    disconnectReason: "removed_by_dashboard",
    disconnectMessage: "Dashboard removed this phone from the session. Tap Start Device to join again."
  });
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

function sanitizeReconnectKey(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  return trimmed.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 128);
}

function sanitizeSessionId(raw) {
  if (typeof raw !== "string") return null;
  if (!/^session_[A-Za-z0-9_]+$/.test(raw)) return null;
  return raw;
}

function makeSessionIdFromName(raw) {
  const slug = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .slice(0, 96);
  if (!slug) return null;
  return sanitizeSessionId(`session_${slug}`);
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

function listDatasetIds() {
  if (!fs.existsSync(DATASETS_ROOT)) return [];
  return fs.readdirSync(DATASETS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("session_"))
    .map((d) => d.name)
    .sort()
    .reverse();
}

function safeReadJson(absPath) {
  try {
    if (!absPath || !fs.existsSync(absPath)) return null;
    return JSON.parse(fs.readFileSync(absPath, "utf8"));
  } catch {
    return null;
  }
}

function buildDatasetSummary(id) {
  try {
    const root = path.join(DATASETS_ROOT, String(id || ""));
    if (!fs.existsSync(root)) return null;
    const stat = fs.statSync(root);
    const meta = safeReadJson(path.join(root, "meta.json"));
    const sync = safeReadJson(path.join(root, "sync_report.json"));
    const exportsRoot = path.join(root, EXPORTS_DIRNAME);
    const sessionSizeBytes = dirSizeBytes(root);
    const durationMs = datasetDurationMs({ meta, sync, fallbackEndMs: Number(stat.mtimeMs || Date.now()) });
    const deviceIds = new Set();

    for (const value of meta?.target_device_ids || []) deviceIds.add(String(value));
    for (const value of Object.keys(meta?.devices || {})) deviceIds.add(String(value));
    for (const value of Object.keys(sync?.devices || {})) deviceIds.add(String(value));

    const devicesRoot = path.join(root, "devices");
    if (fs.existsSync(devicesRoot)) {
      for (const entry of fs.readdirSync(devicesRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) deviceIds.add(String(entry.name));
      }
    }

    const normalizedDeviceIds = [...deviceIds].filter(Boolean).sort();
    const exports = {
      multiview: fs.existsSync(path.join(exportsRoot, SESSION_MULTIVIEW_NAME)),
      multiviewWithAudio: fs.existsSync(path.join(exportsRoot, SESSION_MULTIVIEW_WITH_AUDIO_NAME)),
      multiviewWithAudioAndGps: fs.existsSync(path.join(exportsRoot, SESSION_MULTIVIEW_WITH_AUDIO_AND_GPS_NAME)),
      manifestJson: fs.existsSync(path.join(exportsRoot, SESSION_MULTIVIEW_MANIFEST_NAME)),
      gpsPlaybackJson: fs.existsSync(path.join(exportsRoot, SESSION_GPS_PLAYBACK_NAME)),
      gpsPlaybackVideo: fs.existsSync(path.join(exportsRoot, SESSION_GPS_PLAYBACK_VIDEO_NAME))
    };
    const activeSessionId = recording?.session_dir ? path.basename(String(recording.session_dir || "")) : "";

    return {
      id: String(id),
      session_name: String(meta?.session_name || id),
      created_at_iso: String(meta?.created_at_iso || meta?.start_time_iso || stat.birthtime?.toISOString?.() || stat.mtime?.toISOString?.()),
      updated_at_ms: Number(stat.mtimeMs || Date.now()),
      recording_mode: String(meta?.recording_mode || sync?.recording_mode || "all"),
      focused_device_id: meta?.focused_device_id || firstDeviceId(root) || null,
      target_device_ids: Array.isArray(meta?.target_device_ids) ? meta.target_device_ids : normalizedDeviceIds,
      requested_modalities: Array.isArray(meta?.requested_modalities) ? meta.requested_modalities : [],
      dataset_format: meta?.dataset_format || null,
      session_size_bytes: sessionSizeBytes,
      duration_ms: durationMs,
      device_count: Number(sync?.device_count || normalizedDeviceIds.length || 0),
      device_ids: normalizedDeviceIds,
      device_names: Object.fromEntries(normalizedDeviceIds.map((deviceId) => [
        deviceId,
        String(sync?.devices?.[deviceId]?.device_name || meta?.device_details?.[deviceId]?.device_name || deviceId)
      ])),
      exports,
      export_count: Object.values(exports).filter(Boolean).length,
      has_meta: !!meta,
      has_sync_report: !!sync,
      active: !!recording?.active && activeSessionId === id
    };
  } catch {
    return null;
  }
}

function datasetDurationMs({ meta, sync, fallbackEndMs = Date.now() }) {
  const metaStartMs = new Date(meta?.start_time_iso || meta?.created_at_iso || "").getTime();
  let startMs = Number.isFinite(metaStartMs) && metaStartMs > 0 ? metaStartMs : Infinity;
  if (!Number.isFinite(startMs) || startMs <= 0) startMs = Infinity;
  let endMs = 0;

  for (const device of Object.values(sync?.devices || {})) {
    for (const segment of device?.sync?.segments || []) {
      const segStart = Number(segment?.start_server_ms || 0);
      const segEnd = Number(segment?.end_server_ms || 0);
      if (segStart > 0) startMs = Math.min(startMs, segStart);
      if (segEnd > 0) endMs = Math.max(endMs, segEnd);
    }
  }

  if (!Number.isFinite(startMs) || startMs <= 0) return 0;
  const syncGeneratedMs = new Date(sync?.generated_at_iso || "").getTime();
  const fallbackMs = Number.isFinite(syncGeneratedMs) && syncGeneratedMs > 0 ? syncGeneratedMs : Number(fallbackEndMs || 0);
  const finalEndMs = Math.max(endMs, fallbackMs);
  if (!Number.isFinite(finalEndMs) || finalEndMs <= startMs) return 0;
  return finalEndMs - startMs;
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function applySessionConfigUpdate(nextConfigInput) {
  const previousSessionConfig = clone(sessionConfig);
  sessionConfig = sanitizeRunConfig(nextConfigInput, sessionConfig);
  const newlyEnabledPermissions = diffNewlyEnabledPermissions(previousSessionConfig, sessionConfig);
  for (const [id, d] of devices.entries()) {
    d.config = clone(sessionConfig);
    sessionManager.updateDeviceConfig(id, d.config);
    sendWs(d.ws, { type: "config", device_id: id, runConfig: d.config });
  }
  if (newlyEnabledPermissions.length) {
    notifyConnectedPhonesPermissionRefresh(newlyEnabledPermissions);
  }
  broadcastToDashboards(buildSessionConfigPayload());
  broadcastState();
}

function diffNewlyEnabledPermissions(previousConfig, nextConfig) {
  const prev = capturePermissionToggleState(previousConfig);
  const next = capturePermissionToggleState(nextConfig);
  const enabled = [];
  if (!prev.camera && next.camera) enabled.push("camera");
  if (!prev.audio && next.audio) enabled.push("audio");
  if (!prev.location && next.location) enabled.push("location");
  return enabled;
}

function capturePermissionToggleState(config) {
  return {
    camera: String(config?.streams?.camera?.mode || "off") !== "off",
    audio: !!config?.streams?.audio?.enabled,
    location: !!config?.streams?.gps?.enabled
  };
}

function notifyConnectedPhonesPermissionRefresh(modalities) {
  const cleanModalities = [...new Set((Array.isArray(modalities) ? modalities : [])
    .map((value) => String(value || "").trim().toLowerCase())
    .filter((value) => ["camera", "audio", "location"].includes(value)))];
  if (!cleanModalities.length) return;
  const friendly = cleanModalities.map((value) => {
    if (value === "audio") return "microphone";
    return value;
  });
  const humanList = joinHumanList(friendly);
  const title = `Dashboard turned on ${humanList}`;
  const message = `The dashboard just enabled ${humanList}. Please refresh this phone's page so Safari can show the permission prompt.`;
  broadcastFleetAlert({
    kind: "permission_refresh",
    source_device_name: "Dashboard",
    title,
    message,
    modalities: cleanModalities
  }, { critical: true });
}

function joinHumanList(items) {
  const clean = (Array.isArray(items) ? items : []).filter(Boolean);
  if (!clean.length) return "permissions";
  if (clean.length === 1) return clean[0];
  if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;
  return `${clean.slice(0, -1).join(", ")}, and ${clean[clean.length - 1]}`;
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
    const target = getExpectedCameraIngressFps(d, { recordingActive: !!d.recordingStatus?.recording });
    const actual = Number(d.stats.camera_fps || 0);
    const previewLive = !!d.state?.camera_preview?.live;
    if (target > 0 && actual < Math.max(1, target * 0.6) && !(previewLive && actual === 0)) {
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
