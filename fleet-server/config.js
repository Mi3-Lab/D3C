const path = require("path");

const DEFAULT_RUN_CONFIG = {
  device_id: "phone1",
  streams: {
    imu: { enabled: true, rate_hz: 30, record: true },
    camera: {
      mode: "off",
      fps: 10,
      jpeg_q: 0.6,
      record: false,
      record_mode: "jpg",
      encode_timing: "post_session",
      jpg_quality: 85,
      video_fps: 10,
      video_bitrate: "2M",
      video_crf: 23,
      downsample_factor: 1
    },
    gps: { enabled: false, rate_hz: 1, record: false },
    audio: { enabled: false, rate_hz: 10, record: false },
    device: { enabled: true, rate_hz: 1, record: false },
    fusion: { enabled: true, record: false },
    events: { enabled: true, record: true },
    net: { enabled: true, record: true }
  },
  network: {
    reconnect_enabled: true,
    max_reconnect_delay_ms: 30000,
    heartbeat_interval_ms: 2000,
    message_queue_size: 1000,
    connection_timeout_ms: 5000
  },
  storage: {
    max_session_age_days: 30,
    max_total_size_gb: 50,
    auto_cleanup: false,
    keep_minimum_sessions: 10,
    on_quota_exceeded: "warn"
  },
  performance: {
    throttle_dashboard: true,
    max_ws_buffer_kb: 1024,
    background_device_rate_limit: 1
  }
};

const STATE_BROADCAST_HZ = 10;
const MOTION_WINDOW_MS = 2000;
const MOTION_THRESHOLDS = {
  stillVar: 0.15,
  movingVar: 1.5
};

const DATASETS_ROOT = path.join(process.cwd(), "datasets");

module.exports = {
  DEFAULT_RUN_CONFIG,
  STATE_BROADCAST_HZ,
  MOTION_WINDOW_MS,
  MOTION_THRESHOLDS,
  DATASETS_ROOT
};

