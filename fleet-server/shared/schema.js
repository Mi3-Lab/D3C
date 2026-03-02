const STREAM_IDS = Object.freeze({
  IMU: "imu",
  CAMERA: "camera",
  GPS: "gps",
  EVENTS: "events",
  NET: "net"
});

const CAMERA_MODES = Object.freeze(["off", "stream"]);
const CAMERA_RECORD_MODES = Object.freeze(["jpg", "video", "both"]);
const CAMERA_ENCODE_TIMING = Object.freeze(["realtime", "post_session", "manual"]);
const WS_ROLES = Object.freeze(["phone", "dashboard"]);

function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sanitizeRunConfig(input, fallback) {
  const base = JSON.parse(JSON.stringify(fallback));
  if (!isObject(input)) return base;

  if (typeof input.device_id === "string" && input.device_id.trim()) {
    base.device_id = input.device_id.trim();
  }

  if (!isObject(input.streams)) return base;

  const inStreams = input.streams;
  const out = base.streams;

  if (isObject(inStreams.imu)) {
    if (typeof inStreams.imu.enabled === "boolean") out.imu.enabled = inStreams.imu.enabled;
    if (Number.isFinite(inStreams.imu.rate_hz)) out.imu.rate_hz = clamp(Math.round(inStreams.imu.rate_hz), 1, 120);
    if (typeof inStreams.imu.record === "boolean") out.imu.record = inStreams.imu.record;
  }

  if (isObject(inStreams.camera)) {
    const requestedCameraMode = inStreams.camera.mode === "preview" ? "stream" : inStreams.camera.mode;
    if (CAMERA_MODES.includes(requestedCameraMode)) out.camera.mode = requestedCameraMode;
    if (Number.isFinite(inStreams.camera.fps)) out.camera.fps = clamp(Math.round(inStreams.camera.fps), 1, 30);
    if (Number.isFinite(inStreams.camera.jpeg_q)) out.camera.jpeg_q = clamp(Number(inStreams.camera.jpeg_q), 0.1, 0.95);
    if (typeof inStreams.camera.record === "boolean") out.camera.record = inStreams.camera.record;
    if (CAMERA_RECORD_MODES.includes(inStreams.camera.record_mode)) {
      out.camera.record_mode = inStreams.camera.record_mode;
    }
    if (CAMERA_ENCODE_TIMING.includes(inStreams.camera.encode_timing)) {
      out.camera.encode_timing = inStreams.camera.encode_timing;
    }
    if (Number.isFinite(inStreams.camera.jpg_quality)) out.camera.jpg_quality = clamp(Math.round(inStreams.camera.jpg_quality), 30, 100);
    if (Number.isFinite(inStreams.camera.video_fps)) out.camera.video_fps = clamp(Math.round(inStreams.camera.video_fps), 1, 60);
    if (typeof inStreams.camera.video_bitrate === "string" && inStreams.camera.video_bitrate.trim()) {
      out.camera.video_bitrate = inStreams.camera.video_bitrate.trim();
    }
    if (Number.isFinite(inStreams.camera.video_crf)) out.camera.video_crf = clamp(Math.round(inStreams.camera.video_crf), 18, 35);
    if (Number.isFinite(inStreams.camera.downsample_factor)) {
      out.camera.downsample_factor = clamp(Math.round(inStreams.camera.downsample_factor), 1, 4);
    }
  }

  if (isObject(inStreams.gps)) {
    if (typeof inStreams.gps.enabled === "boolean") out.gps.enabled = inStreams.gps.enabled;
    if (Number.isFinite(inStreams.gps.rate_hz)) out.gps.rate_hz = clamp(Math.round(inStreams.gps.rate_hz), 1, 10);
    if (typeof inStreams.gps.record === "boolean") out.gps.record = inStreams.gps.record;
  }

  if (isObject(inStreams.audio)) {
    if (typeof inStreams.audio.enabled === "boolean") out.audio.enabled = inStreams.audio.enabled;
    if (Number.isFinite(inStreams.audio.rate_hz)) out.audio.rate_hz = clamp(Math.round(inStreams.audio.rate_hz), 1, 30);
    if (typeof inStreams.audio.record === "boolean") out.audio.record = inStreams.audio.record;
  }

  if (isObject(inStreams.device)) {
    if (typeof inStreams.device.enabled === "boolean") out.device.enabled = inStreams.device.enabled;
    if (Number.isFinite(inStreams.device.rate_hz)) out.device.rate_hz = clamp(Math.round(inStreams.device.rate_hz), 1, 5);
    if (typeof inStreams.device.record === "boolean") out.device.record = inStreams.device.record;
  }

  if (isObject(inStreams.fusion)) {
    if (typeof inStreams.fusion.enabled === "boolean") out.fusion.enabled = inStreams.fusion.enabled;
    if (typeof inStreams.fusion.record === "boolean") out.fusion.record = inStreams.fusion.record;
  }

  if (isObject(inStreams.events) && typeof inStreams.events.record === "boolean") {
    out.events.record = inStreams.events.record;
  }

  if (isObject(inStreams.net)) {
    if (typeof inStreams.net.enabled === "boolean") out.net.enabled = inStreams.net.enabled;
    if (typeof inStreams.net.record === "boolean") out.net.record = inStreams.net.record;
  }

  return base;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

module.exports = {
  STREAM_IDS,
  CAMERA_MODES,
  CAMERA_RECORD_MODES,
  CAMERA_ENCODE_TIMING,
  WS_ROLES,
  sanitizeRunConfig
};

