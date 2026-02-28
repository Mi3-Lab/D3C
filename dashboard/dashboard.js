(() => {
  const els = {
    phoneConn: document.getElementById("phoneConn"),
    recordingPill: document.getElementById("recordingPill"),
    themeToggleBtn: document.getElementById("themeToggleBtn"),
    presetSelect: document.getElementById("presetSelect"),
    deviceSelect: document.getElementById("deviceSelect"),
    deviceListMini: document.getElementById("deviceListMini"),
    startRecFocusedBtn: document.getElementById("startRecFocusedBtn"),
    startRecAllBtn: document.getElementById("startRecAllBtn"),
    stopRecBtn: document.getElementById("stopRecBtn"),
    sessionDir: document.getElementById("sessionDir"),
    imuEnabled: document.getElementById("imuEnabled"),
    imuRate: document.getElementById("imuRate"),
    imuRecord: document.getElementById("imuRecord"),
    cameraMode: document.getElementById("cameraMode"),
    cameraFps: document.getElementById("cameraFps"),
    cameraJpegQ: document.getElementById("cameraJpegQ"),
    jpegQLabel: document.getElementById("jpegQLabel"),
    cameraRecord: document.getElementById("cameraRecord"),
    cameraRecordMode: document.getElementById("cameraRecordMode"),
    cameraEncodeTiming: document.getElementById("cameraEncodeTiming"),
    cameraVideoFps: document.getElementById("cameraVideoFps"),
    cameraVideoBitrate: document.getElementById("cameraVideoBitrate"),
    cameraVideoCrf: document.getElementById("cameraVideoCrf"),
    cameraDownsample: document.getElementById("cameraDownsample"),
    gpsEnabled: document.getElementById("gpsEnabled"),
    gpsRate: document.getElementById("gpsRate"),
    gpsRecord: document.getElementById("gpsRecord"),
    audioEnabled: document.getElementById("audioEnabled"),
    audioRate: document.getElementById("audioRate"),
    audioRecord: document.getElementById("audioRecord"),
    deviceEnabled: document.getElementById("deviceEnabled"),
    deviceRate: document.getElementById("deviceRate"),
    deviceRecord: document.getElementById("deviceRecord"),
    fusionEnabled: document.getElementById("fusionEnabled"),
    fusionRecord: document.getElementById("fusionRecord"),
    eventsRecord: document.getElementById("eventsRecord"),
    netEnabled: document.getElementById("netEnabled"),
    netRecord: document.getElementById("netRecord"),
    eventLabel: document.getElementById("eventLabel"),
    markEventBtn: document.getElementById("markEventBtn"),
    imuCanvas: document.getElementById("imuCanvas"),
    motionPill: document.getElementById("motionPill"),
    motionMeta: document.getElementById("motionMeta"),
    cameraImg: document.getElementById("cameraImg"),
    netStats: document.getElementById("netStats"),
    healthImu: document.getElementById("healthImu"),
    healthCam: document.getElementById("healthCam"),
    healthAudio: document.getElementById("healthAudio"),
    healthBattery: document.getElementById("healthBattery"),
    healthDrop: document.getElementById("healthDrop"),
    healthRtt: document.getElementById("healthRtt"),
    healthElapsed: document.getElementById("healthElapsed"),
    healthLight: document.getElementById("healthLight"),
    healthFusion: document.getElementById("healthFusion"),
    healthStorage: document.getElementById("healthStorage"),
    recordingStreams: document.getElementById("recordingStreams"),
    presetName: document.getElementById("presetName"),
    savePresetBtn: document.getElementById("savePresetBtn"),
    exportPresetBtn: document.getElementById("exportPresetBtn"),
    importPresetFile: document.getElementById("importPresetFile"),
    streamTableBody: document.getElementById("streamTableBody"),
    eventTimeline: document.getElementById("eventTimeline"),
    reloadSessionsBtn: document.getElementById("reloadSessionsBtn"),
    replaySessionSelect: document.getElementById("replaySessionSelect"),
    replaySpeed: document.getElementById("replaySpeed"),
    replayPlayBtn: document.getElementById("replayPlayBtn"),
    replayStopBtn: document.getElementById("replayStopBtn"),
    encodeVideoBtn: document.getElementById("encodeVideoBtn"),
    replayStatus: document.getElementById("replayStatus"),
    replayVideo: document.getElementById("replayVideo"),
    replayAudio: document.getElementById("replayAudio")
  };

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
    }
  };

  let ws = null;
  let runConfig = clone(DEFAULT_RUN_CONFIG);
  let focusedDeviceId = null;
  let deviceList = [];
  const customPresets = loadCustomPresets();
  const imuHistory = [];
  const maxImuHistory = 180;
  let lastCameraTs = null;
  let replayActive = false;
  let replayTimer = null;

  bindUi();
  initTheme();
  refreshPresetOptions();
  loadReplaySessions();
  loadStorageHealth();
  setInterval(loadStorageHealth, 5000);
  connectWs();
  renderConfig();

  function connectWs() {
    ws = new WebSocket(`wss://${location.host}/ws`);
    ws.onopen = () => sendJson({ type: "hello", role: "dashboard" });
    ws.onclose = () => setTimeout(connectWs, 1000);
    ws.onmessage = (ev) => {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg) return;

      if (msg.type === "device_list") {
        deviceList = Array.isArray(msg.devices) ? msg.devices : [];
        renderDeviceList();
        return;
      }
      if (msg.type === "focus") {
        focusedDeviceId = msg.focused_device_id || focusedDeviceId;
        renderDeviceList();
        return;
      }
      if (msg.type === "config") {
        if (msg.device_id) focusedDeviceId = msg.device_id;
        if (focusedDeviceId && msg.device_id && msg.device_id !== focusedDeviceId) return;
        runConfig = mergeRunConfig(msg.runConfig);
        renderConfig();
        return;
      }
      if (msg.type === "state" && !replayActive) {
        renderState(msg);
        return;
      }
      if (msg.type === "recording_error") {
        const reason = msg.error || "unknown";
        const details = msg.details?.currentSize != null && msg.details?.maxBytes != null
          ? ` size=${(msg.details.currentSize / (1024 ** 3)).toFixed(2)}GB max=${(msg.details.maxBytes / (1024 ** 3)).toFixed(2)}GB`
          : "";
        els.recordingPill.textContent = `Recording: blocked (${reason}${details})`;
      }
    };
  }

  function bindUi() {
    const updateIds = [
      "imuEnabled", "imuRate", "imuRecord",
      "cameraMode", "cameraFps", "cameraJpegQ", "cameraRecord", "cameraRecordMode",
      "cameraEncodeTiming", "cameraVideoFps", "cameraVideoBitrate", "cameraVideoCrf", "cameraDownsample",
      "gpsEnabled", "gpsRate", "gpsRecord",
      "audioEnabled", "audioRate", "audioRecord",
      "deviceEnabled", "deviceRate", "deviceRecord",
      "fusionEnabled", "fusionRecord",
      "eventsRecord", "netEnabled", "netRecord"
    ];
    for (const id of updateIds) {
      els[id].addEventListener("change", () => {
        runConfig = readConfigFromUi();
        renderJpegQ();
        renderRecordingStreams();
        pushConfig();
      });
    }
    els.deviceSelect.addEventListener("change", () => {
      const id = els.deviceSelect.value;
      if (!id) return;
      focusedDeviceId = id;
      sendJson({ type: "set_focus", device_id: id });
    });
    els.startRecFocusedBtn.addEventListener("click", () =>
      sendJson({ type: "recording", action: "start", scope: "focused" })
    );
    els.startRecAllBtn.addEventListener("click", () =>
      sendJson({ type: "recording", action: "start", scope: "all" })
    );
    els.stopRecBtn.addEventListener("click", () => sendJson({ type: "recording", action: "stop" }));
    els.markEventBtn.addEventListener("click", () => {
      sendJson({ type: "event", device_id: focusedDeviceId, label: (els.eventLabel.value || "event").trim() });
      els.eventLabel.value = "";
    });
    els.presetSelect.addEventListener("change", () => {
      const v = els.presetSelect.value;
      if (v.startsWith("custom:")) runConfig = mergeRunConfig(customPresets[v.slice(7)]);
      else applyPreset(v);
      renderConfig();
      pushConfig();
    });
    els.savePresetBtn.addEventListener("click", saveCurrentPreset);
    els.exportPresetBtn.addEventListener("click", exportPresetJson);
    els.importPresetFile.addEventListener("change", importPresetJson);
    els.reloadSessionsBtn.addEventListener("click", loadReplaySessions);
    els.replayPlayBtn.addEventListener("click", playReplay);
    els.replayStopBtn.addEventListener("click", stopReplay);
    els.encodeVideoBtn.addEventListener("click", encodeCurrentReplaySession);
    els.themeToggleBtn.addEventListener("click", toggleTheme);
  }

  function renderConfig() {
    const s = runConfig.streams;
    setValue("imuEnabled", s.imu.enabled); setValue("imuRate", s.imu.rate_hz); setValue("imuRecord", s.imu.record);
    setValue("cameraMode", s.camera.mode); setValue("cameraFps", s.camera.fps); setValue("cameraJpegQ", s.camera.jpeg_q);
    setValue("cameraRecord", s.camera.record); setValue("cameraRecordMode", s.camera.record_mode || "jpg");
    setValue("cameraEncodeTiming", s.camera.encode_timing || "post_session");
    setValue("cameraVideoFps", s.camera.video_fps || s.camera.fps || 10);
    setValue("cameraVideoBitrate", s.camera.video_bitrate || "2M");
    setValue("cameraVideoCrf", s.camera.video_crf || 23);
    setValue("cameraDownsample", s.camera.downsample_factor || 1);
    setValue("gpsEnabled", s.gps.enabled); setValue("gpsRate", s.gps.rate_hz); setValue("gpsRecord", s.gps.record);
    setValue("audioEnabled", s.audio.enabled); setValue("audioRate", s.audio.rate_hz); setValue("audioRecord", s.audio.record);
    setValue("deviceEnabled", s.device.enabled); setValue("deviceRate", s.device.rate_hz); setValue("deviceRecord", s.device.record);
    setValue("fusionEnabled", s.fusion.enabled); setValue("fusionRecord", s.fusion.record);
    setValue("eventsRecord", s.events.record); setValue("netEnabled", s.net.enabled); setValue("netRecord", s.net.record);
    renderJpegQ();
    renderRecordingStreams();
  }

  function renderState(st) {
    focusedDeviceId = st.focused_device_id || focusedDeviceId;
    if (Array.isArray(st.devices)) {
      deviceList = st.devices;
      renderDeviceList();
    }
    const f = st.focused || {};
    els.phoneConn.textContent = `Phone: ${f.connected ? "connected" : "disconnected"}`;
    els.recordingPill.textContent = `Recording: ${st.recording.active ? `on (${st.recording.mode})` : "off"}`;
    els.sessionDir.textContent = `session: ${st.recording.session_dir || "none"}`;

    if (f.imu_latest?.mag != null) {
      imuHistory.push(f.imu_latest.mag);
      if (imuHistory.length > maxImuHistory) imuHistory.shift();
      drawImuPlot();
    }
    updateMotionPill(f.motion_state || "UNKNOWN");
    els.motionMeta.textContent = `confidence=${Number(f.motion_conf || 0).toFixed(2)} inactivity=${Number(f.inactivity_duration_sec || 0).toFixed(1)}s`;
    const rtt = f.net?.rtt_ms == null ? "-" : Number(f.net.rtt_ms).toFixed(0);
    els.netStats.textContent = `imu_hz=${Number(f.net?.imu_hz || 0).toFixed(1)} cam_fps=${Number(f.net?.camera_fps || 0).toFixed(1)} dropped=${f.net?.dropped_packets || 0} rtt_ms=${rtt}`;
    els.healthImu.textContent = `IMU Hz: ${Number(f.net?.imu_hz || 0).toFixed(1)}`;
    els.healthCam.textContent = `Camera FPS: ${Number(f.net?.camera_fps || 0).toFixed(1)}`;
    els.healthAudio.textContent = `Audio amp: ${f.audio_latest ? Number(f.audio_latest.amplitude || 0).toFixed(3) : "-"}`;
    els.healthBattery.textContent = `Battery: ${f.device_latest && Number(f.device_latest.battery_level) >= 0 ? `${Number(f.device_latest.battery_level).toFixed(1)}% ${f.device_latest.charging ? "(charging)" : ""}` : "-"}`;
    els.healthDrop.textContent = `Dropped: ${f.net?.dropped_packets || 0}`;
    els.healthRtt.textContent = `RTT ms: ${rtt}`;
    els.healthElapsed.textContent = `Rec Elapsed: ${formatElapsed(st.recording.elapsed_sec || 0)}`;
    els.healthLight.textContent = `Lighting: ${f.camera_quality?.lighting_score == null ? "-" : Number(f.camera_quality.lighting_score).toFixed(3)}`;
    els.healthFusion.textContent = `Fusion: cq=${Number(f.fusion?.connection_quality || 0).toFixed(2)} sc=${Number(f.fusion?.sensing_confidence || 0).toFixed(2)}`;

    renderStreamTable(f.stream_status || {});
    renderEventTimeline(f.event_timeline || []);
    if (f.camera_latest_ts && f.camera_latest_ts !== lastCameraTs && runConfig.streams.camera.mode === "stream") {
      lastCameraTs = f.camera_latest_ts;
      els.cameraImg.src = `/latest.jpg?device_id=${encodeURIComponent(focusedDeviceId || "")}&ts=${f.camera_latest_ts}`;
    }
  }

  function renderDeviceList() {
    const prevFocused = focusedDeviceId;
    els.deviceSelect.innerHTML = "";
    if (!deviceList.length) {
      els.deviceListMini.textContent = "No devices connected";
      const opt = document.createElement("option"); opt.value = ""; opt.textContent = "No devices";
      els.deviceSelect.appendChild(opt);
      return;
    }
    for (const d of deviceList) {
      const opt = document.createElement("option");
      opt.value = d.device_id;
      opt.textContent = d.device_id;
      els.deviceSelect.appendChild(opt);
    }
    if (!focusedDeviceId || !deviceList.some((d) => d.device_id === focusedDeviceId)) focusedDeviceId = deviceList[0].device_id;
    els.deviceSelect.value = focusedDeviceId;
    if (focusedDeviceId && focusedDeviceId !== prevFocused) {
      sendJson({ type: "set_focus", device_id: focusedDeviceId });
    }
    els.deviceListMini.textContent = deviceList
      .map((d) => `${d.device_id}:${d.connectionStatus || (d.connected ? "on" : "off")} imu=${Number(d.imuHz || 0).toFixed(1)} cam=${Number(d.camFps || 0).toFixed(1)} rtt=${d.rttMs ?? "-"}`)
      .join(" | ");
  }

  function readConfigFromUi() {
    return {
      device_id: focusedDeviceId || runConfig.device_id,
      streams: {
        imu: { enabled: els.imuEnabled.checked, rate_hz: Number(els.imuRate.value), record: els.imuRecord.checked },
        camera: {
          mode: els.cameraMode.value,
          fps: Number(els.cameraFps.value),
          jpeg_q: Number(els.cameraJpegQ.value),
          record: els.cameraRecord.checked,
          record_mode: els.cameraRecordMode.value,
          encode_timing: els.cameraEncodeTiming.value,
          video_fps: Number(els.cameraVideoFps.value),
          video_bitrate: (els.cameraVideoBitrate.value || "2M").trim() || "2M",
          video_crf: Number(els.cameraVideoCrf.value),
          downsample_factor: Number(els.cameraDownsample.value)
        },
        gps: { enabled: els.gpsEnabled.checked, rate_hz: Number(els.gpsRate.value), record: els.gpsRecord.checked },
        audio: { enabled: els.audioEnabled.checked, rate_hz: Number(els.audioRate.value), record: els.audioRecord.checked },
        device: { enabled: els.deviceEnabled.checked, rate_hz: Number(els.deviceRate.value), record: els.deviceRecord.checked },
        fusion: { enabled: els.fusionEnabled.checked, record: els.fusionRecord.checked },
        events: { enabled: true, record: els.eventsRecord.checked },
        net: { enabled: els.netEnabled.checked, record: els.netRecord.checked }
      }
    };
  }

  function pushConfig() {
    if (!focusedDeviceId) return;
    sendJson({ type: "set_config", device_id: focusedDeviceId, runConfig });
  }

  function applyPreset(name) {
    const s = runConfig.streams;
    if (name === "imu-only") { s.imu.enabled = true; s.imu.rate_hz = 60; s.imu.record = true; s.camera.mode = "off"; s.camera.record = false; return; }
    if (name === "camera-only") { s.imu.enabled = false; s.imu.record = false; s.camera.mode = "stream"; s.camera.fps = 10; s.camera.record = true; s.camera.record_mode = "jpg"; return; }
    if (name === "no-camera-privacy") { s.camera.mode = "off"; s.camera.record = false; s.imu.enabled = true; s.imu.record = true; return; }
    if (name === "full-multimodal") { s.imu.enabled = true; s.camera.mode = "stream"; s.camera.record = true; s.audio.enabled = true; s.device.enabled = true; return; }
  }

  function renderRecordingStreams() {
    const s = runConfig.streams;
    els.recordingStreams.textContent =
      `Recording: imu ${onOff(s.imu.record)} | camera ${onOff(s.camera.record && s.camera.mode === "stream")}(${s.camera.record_mode || "jpg"}) | audio ${onOff(s.audio.record)} | device ${onOff(s.device.record)} | fusion ${onOff(s.fusion.record)} | events ${onOff(s.events.record)} | net ${onOff(s.net.record)}`;
  }

  function renderStreamTable(streamStatus) {
    const ids = ["imu", "camera", "gps", "audio", "device", "fusion", "events", "net"];
    els.streamTableBody.innerHTML = "";
    for (const id of ids) {
      const s = streamStatus[id] || {};
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${id}</td><td>${!!s.enabled}</td><td>${!!s.recording}</td><td>${s.rate || "-"}</td><td>${formatTs(s.last_seen_ms)}</td>`;
      els.streamTableBody.appendChild(tr);
    }
  }

  function renderEventTimeline(events) {
    els.eventTimeline.innerHTML = "";
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i];
      const li = document.createElement("li");
      li.textContent = `${formatTs(ev.t_recv_ms)} ${ev.source || "unknown"}: ${ev.label || ""}`;
      els.eventTimeline.appendChild(li);
    }
  }

  function drawImuPlot() {
    const c = els.imuCanvas;
    const ctx = c.getContext("2d");
    const w = c.width;
    const h = c.height;
    ctx.clearRect(0, 0, w, h);
    const style = getComputedStyle(document.documentElement);
    const gridColor = style.getPropertyValue("--plot-grid").trim() || "#cccccc";
    const lineColor = style.getPropertyValue("--plot-line").trim() || "#6c74c9";
    ctx.strokeStyle = gridColor; ctx.beginPath(); ctx.moveTo(0, h - 1); ctx.lineTo(w, h - 1); ctx.stroke();
    if (imuHistory.length < 2) return;
    let max = 12; for (const v of imuHistory) max = Math.max(max, v);
    ctx.strokeStyle = lineColor; ctx.lineWidth = 2; ctx.beginPath();
    for (let i = 0; i < imuHistory.length; i += 1) {
      const x = (i / (maxImuHistory - 1)) * w;
      const y = h - (imuHistory[i] / max) * (h - 6) - 3;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function updateMotionPill(state) {
    els.motionPill.textContent = state;
    if (state === "STILL") { els.motionPill.style.background = "#4caf50"; els.motionPill.style.color = "#fff"; return; }
    if (state === "MOVING") { els.motionPill.style.background = "#ff9800"; els.motionPill.style.color = "#102022"; return; }
    if (state === "HIGH") { els.motionPill.style.background = "#f44336"; els.motionPill.style.color = "#fff"; return; }
    els.motionPill.style.background = "#cccccc"; els.motionPill.style.color = "#102022";
  }

  async function loadReplaySessions() {
    try {
      const data = await (await fetch("/api/datasets")).json();
      const sessions = Array.isArray(data.sessions) ? data.sessions : [];
      els.replaySessionSelect.innerHTML = "";
      for (const id of sessions) {
        const opt = document.createElement("option"); opt.value = id; opt.textContent = id;
        els.replaySessionSelect.appendChild(opt);
      }
      if (!sessions.length) {
        const opt = document.createElement("option"); opt.value = ""; opt.textContent = "No sessions";
        els.replaySessionSelect.appendChild(opt);
      }
    } catch { els.replayStatus.textContent = "Replay: failed to load sessions"; }
  }

  async function playReplay() {
    const sessionId = els.replaySessionSelect.value;
    if (!sessionId) return;
    stopReplay();
    replayActive = true;
    const qs = focusedDeviceId ? `?device_id=${encodeURIComponent(focusedDeviceId)}` : "";
    const manifest = await (await fetch(`/api/datasets/${encodeURIComponent(sessionId)}/manifest${qs}`)).json();
    const speed = Math.max(0.25, Number(els.replaySpeed.value || 1));
    const imuRows = manifest.imuCsv ? parseImuCsv(await (await fetch(manifest.imuCsv)).text()) : [];
    const evRows = manifest.eventsCsv ? parseEventsCsv(await (await fetch(manifest.eventsCsv)).text()) : [];
    const camRows = manifest.cameraTimestampsCsv ? parseCameraTsCsv(await (await fetch(manifest.cameraTimestampsCsv)).text()) : [];
    if (manifest.cameraVideo) { els.replayVideo.style.display = "block"; els.replayVideo.src = manifest.cameraVideo; }
    else { els.replayVideo.style.display = "none"; els.replayVideo.removeAttribute("src"); }
    if (manifest.audioWav && els.replayAudio) {
      els.replayAudio.style.display = "block";
      els.replayAudio.src = manifest.audioWav;
      els.replayAudio.playbackRate = speed;
      els.replayAudio.currentTime = 0;
      els.replayAudio.play().catch(() => {});
    } else if (els.replayAudio) {
      els.replayAudio.pause();
      els.replayAudio.style.display = "none";
      els.replayAudio.removeAttribute("src");
    }
    if (!imuRows.length && !evRows.length && !camRows.length && !manifest.cameraVideo && !manifest.audioWav) { replayActive = false; return; }

    const startTs = (imuRows[0]?.t_recv_ms) || (evRows[0]?.t_recv_ms) || (camRows[0]?.t_recv_ms) || Date.now();
    const endTs = Math.max(
      imuRows.length ? imuRows[imuRows.length - 1].t_recv_ms : startTs,
      evRows.length ? evRows[evRows.length - 1].t_recv_ms : startTs,
      camRows.length ? camRows[camRows.length - 1].t_recv_ms : startTs
    );
    const wallStart = Date.now();
    let imuIdx = 0; let evIdx = 0; let camIdx = 0;
    const replayEvents = [];
    imuHistory.length = 0;

    replayTimer = setInterval(() => {
      const nowTs = startTs + (Date.now() - wallStart) * speed;
      while (imuIdx < imuRows.length && imuRows[imuIdx].t_recv_ms <= nowTs) {
        imuHistory.push(imuRows[imuIdx++].mag); if (imuHistory.length > maxImuHistory) imuHistory.shift();
      }
      drawImuPlot();
      while (evIdx < evRows.length && evRows[evIdx].t_recv_ms <= nowTs) replayEvents.push(evRows[evIdx++]);
      renderEventTimeline(replayEvents.slice(-50));
      while (camIdx < camRows.length && camRows[camIdx].t_recv_ms <= nowTs) {
        els.cameraImg.src = `/datasets/${sessionId}/devices/${manifest.device_id}/streams/camera/${camRows[camIdx++].filename}`;
      }
      els.replayStatus.textContent = `Replay: ${sessionId} @ ${speed}x`;
      if (nowTs >= endTs) stopReplay("Replay: done");
    }, 40);
  }

  function stopReplay(status = "Replay: idle") {
    replayActive = false;
    if (replayTimer) clearInterval(replayTimer);
    replayTimer = null;
    els.replayStatus.textContent = status;
    if (els.replayAudio) {
      els.replayAudio.pause();
    }
  }

  async function encodeCurrentReplaySession() {
    const sessionId = els.replaySessionSelect.value;
    if (!sessionId || !focusedDeviceId) return;
    els.replayStatus.textContent = "Replay: encoding video...";
    try {
      const resp = await fetch(`/api/datasets/${encodeURIComponent(sessionId)}/encode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_id: focusedDeviceId,
          fps: runConfig.streams.camera.video_fps || runConfig.streams.camera.fps || 10,
          bitrate: runConfig.streams.camera.video_bitrate || "2M",
          crf: runConfig.streams.camera.video_crf || 23
        })
      });
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        els.replayStatus.textContent = `Replay: encode failed (${data.error || resp.status})`;
        return;
      }
      els.replayStatus.textContent = "Replay: encode complete";
      await loadReplaySessions();
    } catch {
      els.replayStatus.textContent = "Replay: encode failed";
    }
  }

  async function loadStorageHealth() {
    try {
      const data = await (await fetch("/api/storage")).json();
      const gb = Number(data.sessions_size_gb || 0).toFixed(2);
      const count = Number(data.session_count || 0);
      const freeGb = Number.isFinite(data.free_disk_bytes) ? (Number(data.free_disk_bytes) / (1024 ** 3)).toFixed(1) : "?";
      els.healthStorage.textContent = `Storage: ${gb}GB / ${count} datasets | free ${freeGb}GB`;
    } catch {
      els.healthStorage.textContent = "Storage: unavailable";
    }
  }

  function parseImuCsv(text) {
    const rows = [];
    for (const line of text.split(/\r?\n/).slice(1)) {
      if (!line.trim()) continue;
      const p = line.split(",");
      const t = Number(p[0]); const ax = Number(p[2]); const ay = Number(p[3]); const az = Number(p[4]);
      rows.push({ t_recv_ms: t, mag: Math.sqrt(ax * ax + ay * ay + az * az) });
    }
    return rows;
  }

  function parseCameraTsCsv(text) {
    const rows = [];
    for (const line of text.split(/\r?\n/).slice(1)) {
      if (!line.trim()) continue;
      const p = line.split(",");
      if (p.length >= 4) rows.push({ filename: p[1], t_recv_ms: Number(p[3]) });
    }
    return rows;
  }

  function parseEventsCsv(text) {
    const rows = [];
    for (const line of text.split(/\r?\n/).slice(1)) {
      if (!line.trim()) continue;
      const first = line.indexOf(","); const second = line.indexOf(",", first + 1); const third = line.indexOf(",", second + 1);
      if (first < 0 || second < 0 || third < 0) continue;
      rows.push({ t_recv_ms: Number(line.slice(0, first)), label: line.slice(second + 1, third).replace(/^"|"$/g, ""), source: "replay" });
    }
    return rows;
  }

  function saveCurrentPreset() {
    const name = (els.presetName.value || "").trim();
    if (!name) return;
    customPresets[name] = clone(runConfig);
    localStorage.setItem("phonesense_custom_presets", JSON.stringify(customPresets));
    refreshPresetOptions(name);
  }

  function exportPresetJson() {
    const blob = new Blob([JSON.stringify(runConfig, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "phonesense_preset.json";
    a.click();
  }

  async function importPresetJson() {
    const file = els.importPresetFile.files?.[0];
    if (!file) return;
    runConfig = mergeRunConfig(JSON.parse(await file.text()));
    renderConfig();
    pushConfig();
    els.importPresetFile.value = "";
  }

  function refreshPresetOptions(selectName) {
    const current = els.presetSelect.value;
    for (const option of [...els.presetSelect.querySelectorAll("option[data-custom='1']")]) option.remove();
    for (const name of Object.keys(customPresets).sort()) {
      const opt = document.createElement("option");
      opt.value = `custom:${name}`; opt.textContent = `Custom: ${name}`; opt.dataset.custom = "1";
      els.presetSelect.appendChild(opt);
    }
    if (selectName && customPresets[selectName]) els.presetSelect.value = `custom:${selectName}`;
    else if (current) els.presetSelect.value = current;
  }

  function loadCustomPresets() {
    try { return JSON.parse(localStorage.getItem("phonesense_custom_presets") || "{}"); }
    catch { return {}; }
  }

  function initTheme() {
    applyTheme(localStorage.getItem("phonesense_theme") === "dark" ? "dark" : "light");
  }
  function toggleTheme() {
    applyTheme((document.body.getAttribute("data-theme") || "light") === "light" ? "dark" : "light");
  }
  function applyTheme(theme) {
    document.body.setAttribute("data-theme", theme);
    localStorage.setItem("phonesense_theme", theme);
    els.themeToggleBtn.textContent = theme === "light" ? "Dark Mode" : "Light Mode";
    drawImuPlot();
  }

  function mergeRunConfig(input) {
    const merged = clone(DEFAULT_RUN_CONFIG);
    if (!input || typeof input !== "object") return merged;
    merged.device_id = typeof input.device_id === "string" ? input.device_id : merged.device_id;
    const inS = input.streams || {};
    for (const key of Object.keys(merged.streams)) merged.streams[key] = { ...merged.streams[key], ...(inS[key] || {}) };
    return merged;
  }

  function setValue(id, value) {
    const el = els[id];
    if (el.type === "checkbox") el.checked = !!value;
    else el.value = String(value);
  }

  function onOff(v) { return v ? "on" : "off"; }
  function formatTs(t) { return t ? new Date(Number(t)).toLocaleTimeString() : "-"; }
  function formatElapsed(sec) { const s = Math.max(0, Number(sec || 0)); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; }
  function renderJpegQ() { els.jpegQLabel.textContent = Number(els.cameraJpegQ.value).toFixed(2); }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function sendJson(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
})();





