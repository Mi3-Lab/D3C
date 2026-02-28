function createMessageRouter(ctx) {
  return {
    onPhoneJson(msg, ws) {
      if (msg.type === "imu") return handleImu(msg, ctx);
      if (msg.type === "camera_header") return handleCameraHeader(msg, ws, ctx);
      if (msg.type === "audio") return handleAudio(msg, ctx);
      if (msg.type === "device") return handleDevice(msg, ctx);
      if (msg.type === "event") return handleEvent(msg, "phone", ctx);
      if (msg.type === "pong") return handlePong(msg, ctx);
    },
    onPhoneBinary(data, ws) {
      const pending = ctx.pendingCameraHeaderBySocket.get(ws);
      if (!pending) return;
      ctx.pendingCameraHeaderBySocket.delete(ws);
      handleCameraBinary(data, pending, ctx);
    },
    onDashboardJson(msg) {
      if (msg.type === "set_config") return handleSetConfig(msg, ctx);
      if (msg.type === "recording") return handleRecording(msg, ctx);
      if (msg.type === "event") return handleEvent(msg, "dashboard", ctx);
    }
  };
}

function handleImu(msg, ctx) {
  const tRecvMs = Date.now();
  const accel = Array.isArray(msg.accel_mps2) ? msg.accel_mps2 : [0, 0, 0];
  const gyro = Array.isArray(msg.gyro_rads) ? msg.gyro_rads : [0, 0, 0];
  const ax = Number(accel[0] || 0);
  const ay = Number(accel[1] || 0);
  const az = Number(accel[2] || 0);
  const gx = Number(gyro[0] || 0);
  const gy = Number(gyro[1] || 0);
  const gz = Number(gyro[2] || 0);

  const mag = Math.sqrt(ax * ax + ay * ay + az * az);
  const motion = ctx.motionClassifier.update(ax, ay, az);
  ctx.imuStats.receivedSinceLast += 1;

  ctx.state.motion_state = motion.motion_state;
  ctx.state.motion_conf = motion.confidence;
  if (motion.motion_state === "STILL") {
    if (!ctx.stillSinceMs) ctx.stillSinceMs = tRecvMs;
    ctx.state.inactivity_duration_sec = Number(((tRecvMs - ctx.stillSinceMs) / 1000).toFixed(1));
  } else {
    ctx.stillSinceMs = null;
    ctx.state.inactivity_duration_sec = 0;
  }
  ctx.state.imu_latest = {
    t_recv_ms: tRecvMs,
    t_device_ms: Number(msg.t_device_ms || 0),
    accel_mps2: [ax, ay, az],
    gyro_rads: [gx, gy, gz],
    mag
  };
  if (ctx.state.stream_status?.imu) ctx.state.stream_status.imu.last_seen_ms = tRecvMs;

  ctx.sessionManager.writeImu({
    t_recv_ms: tRecvMs,
    t_device_ms: Number(msg.t_device_ms || 0),
    ax,
    ay,
    az,
    gx,
    gy,
    gz
  });
}

function handleCameraHeader(msg, ws, ctx) {
  ctx.pendingCameraHeaderBySocket.set(ws, {
    device_id: msg.device_id,
    t_device_ms: Number(msg.t_device_ms || 0),
    frame_id: msg.frame_id || "phone_camera",
    format: msg.format || "jpeg",
    lighting_score: Number.isFinite(msg.lighting_score) ? Number(msg.lighting_score) : null
  });
}

function handleCameraBinary(data, header, ctx) {
  const tRecvMs = Date.now();
  ctx.latestCameraBuffer = Buffer.from(data);
  ctx.latestCameraMime = header.format === "jpeg" ? "image/jpeg" : "application/octet-stream";
  ctx.state.camera_latest_ts = tRecvMs;
  if (Number.isFinite(header.lighting_score)) {
    ctx.state.camera_quality.lighting_score = header.lighting_score;
  }
  if (ctx.state.stream_status?.camera) ctx.state.stream_status.camera.last_seen_ms = tRecvMs;

  ctx.cameraStats.receivedSinceLast += 1;

  ctx.sessionManager.writeCamera({
    jpegBuffer: ctx.latestCameraBuffer,
    t_device_ms: header.t_device_ms,
    t_recv_ms: tRecvMs
  });
}

function handleEvent(msg, source, ctx) {
  const tRecvMs = Date.now();
  const label = String(msg.label || "").slice(0, 200);
  const tDevice = Number(msg.t_device_ms || 0);
  const meta = { ...(msg.meta || {}), source };
  ctx.sessionManager.writeEvent({
    t_recv_ms: tRecvMs,
    t_device_ms: tDevice,
    label,
    meta
  });
  if (ctx.state.stream_status?.events) ctx.state.stream_status.events.last_seen_ms = tRecvMs;
  ctx.state.event_timeline.push({ t_recv_ms: tRecvMs, label, source });
  if (ctx.state.event_timeline.length > 50) ctx.state.event_timeline.shift();
}

function handleAudio(msg, ctx) {
  const tRecvMs = Date.now();
  const amplitude = Number(msg.amplitude || 0);
  const noiseLevel = Number(msg.noise_level || 0);
  ctx.state.audio_latest = {
    t_recv_ms: tRecvMs,
    t_device_ms: Number(msg.t_device_ms || 0),
    amplitude,
    noise_level: noiseLevel
  };
  if (ctx.state.stream_status?.audio) ctx.state.stream_status.audio.last_seen_ms = tRecvMs;
  ctx.sessionManager.writeAudio({
    t_recv_ms: tRecvMs,
    t_device_ms: Number(msg.t_device_ms || 0),
    amplitude,
    noise_level: noiseLevel
  });
}

function handleDevice(msg, ctx) {
  const tRecvMs = Date.now();
  const batteryLevel = Number(msg.battery_level ?? -1);
  const charging = !!msg.charging;
  const orientation = String(msg.orientation || "unknown");
  ctx.state.device_latest = {
    t_recv_ms: tRecvMs,
    t_device_ms: Number(msg.t_device_ms || 0),
    battery_level: batteryLevel,
    charging,
    orientation
  };
  if (ctx.state.stream_status?.device) ctx.state.stream_status.device.last_seen_ms = tRecvMs;
  ctx.sessionManager.writeDevice({
    t_recv_ms: tRecvMs,
    t_device_ms: Number(msg.t_device_ms || 0),
    battery_level: batteryLevel,
    charging,
    orientation
  });
}

function handlePong(msg, ctx) {
  const pingId = String(msg.ping_id || "");
  const rec = ctx.pendingPings.get(pingId);
  if (!rec) return;
  const rtt = Date.now() - rec.t_sent_ms;
  ctx.state.net.rtt_ms = rtt;
  if (ctx.state.stream_status?.net) ctx.state.stream_status.net.last_seen_ms = Date.now();
  ctx.pendingPings.delete(pingId);
}

function handleSetConfig(msg, ctx) {
  const next = ctx.sanitizeRunConfig(msg.runConfig, ctx.runConfig);
  ctx.runConfig = next;
  applyConfigToStreamStatus(ctx.state.stream_status, next);
  ctx.sessionManager.updateConfig(next);
  ctx.sessionManager.logControl({
    type: "set_config",
    at_iso: new Date().toISOString(),
    runConfig: next
  });
  ctx.broadcastToDashboards({ type: "config", runConfig: next });
  ctx.sendToPhone({ type: "config", runConfig: next });
}

function handleRecording(msg, ctx) {
  const action = msg.action;
  if (action === "start") {
    const res = ctx.sessionManager.start(ctx.runConfig, {
      started_by: "dashboard",
      session_name_optional: msg.session_name_optional || null,
      ...ctx.getRecordingMeta()
    });
    ctx.state.recording.active = true;
    ctx.state.recording.session_dir = res.sessionDir;
    ctx.state.recording.started_at_ms = Date.now();
    ctx.state.recording.elapsed_sec = 0;
  } else if (action === "stop") {
    const res = ctx.sessionManager.stop();
    ctx.state.recording.active = false;
    ctx.state.recording.session_dir = res.sessionDir;
    ctx.state.recording.started_at_ms = null;
    ctx.state.recording.elapsed_sec = 0;
  }
}

function applyConfigToStreamStatus(streamStatus, runConfig) {
  if (!streamStatus || !runConfig?.streams) return;
  const s = runConfig.streams;
  streamStatus.imu.enabled = !!s.imu.enabled;
  streamStatus.imu.recording = !!s.imu.record;
  streamStatus.imu.rate = `${Number(s.imu.rate_hz || 0)} Hz`;

  streamStatus.camera.enabled = s.camera.mode !== "off";
  streamStatus.camera.recording = !!s.camera.record && s.camera.mode === "stream";
  streamStatus.camera.rate =
    s.camera.mode === "stream"
      ? `${Number(s.camera.fps || 0)} fps (${s.camera.record_mode || "jpg"})`
      : s.camera.mode;

  streamStatus.gps.enabled = !!s.gps.enabled;
  streamStatus.gps.recording = !!s.gps.record;
  streamStatus.gps.rate = `${Number(s.gps.rate_hz || 0)} Hz`;

  streamStatus.audio.enabled = !!s.audio?.enabled;
  streamStatus.audio.recording = !!s.audio?.record;
  streamStatus.audio.rate = `${Number(s.audio?.rate_hz || 0)} Hz`;

  streamStatus.device.enabled = !!s.device?.enabled;
  streamStatus.device.recording = !!s.device?.record;
  streamStatus.device.rate = `${Number(s.device?.rate_hz || 0)} Hz`;

  streamStatus.events.enabled = true;
  streamStatus.events.recording = !!s.events.record;
  streamStatus.events.rate = "-";

  streamStatus.net.enabled = !!s.net.enabled;
  streamStatus.net.recording = !!s.net.record;
  streamStatus.net.rate = "-";

  streamStatus.fusion.enabled = !!s.fusion?.enabled;
  streamStatus.fusion.recording = !!s.fusion?.record;
  streamStatus.fusion.rate = "-";
}

module.exports = {
  createMessageRouter
};
