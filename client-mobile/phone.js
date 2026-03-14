(() => {
  const startBtn = document.getElementById("startBtn");
  const themeToggleBtn = document.getElementById("phoneThemeToggleBtn");
  const disconnectBtn = document.getElementById("disconnectBtn");
  const connStatus = document.getElementById("connStatus");
  const deviceIdPill = document.getElementById("deviceIdPill");
  const statusList = document.getElementById("statusList");
  const deviceNameInput = document.getElementById("deviceNameInput");
  const joinCodeInput = document.getElementById("joinCodeInput");
  const joinStatus = document.getElementById("joinStatus");
  const previewEl = document.getElementById("preview");
  const phoneConnCard = document.getElementById("phoneConnCard");
  const phoneConnText = document.getElementById("phoneConnText");
  const phoneCameraCard = document.getElementById("phoneCameraCard");
  const phoneCameraMode = document.getElementById("phoneCameraMode");
  const phoneAudioCard = document.getElementById("phoneAudioCard");
  const phoneAudioMode = document.getElementById("phoneAudioMode");
  const phoneReadySummary = document.getElementById("phoneReadySummary");
  const phoneReadinessList = document.getElementById("phoneReadinessList");
  const phoneGuidanceList = document.getElementById("phoneGuidanceList");
  const RECONNECT_KEY_STORAGE = "d3c_phone_reconnect_key";

  const DEFAULT_RUN_CONFIG = {
    device_id: resolveDeviceId(),
    streams: {
      imu: { enabled: true, rate_hz: 30, record: false },
      camera: { mode: "off", fps: 10, jpeg_q: 0.6, record: false, record_mode: "jpg" },
      gps: { enabled: false, rate_hz: 1, record: false },
      audio: { enabled: false, rate_hz: 10, record: false },
      device: { enabled: true, rate_hz: 1, record: false },
      fusion: { enabled: true, record: false },
      events: { enabled: true, record: false },
      net: { enabled: true, record: false }
    },
    network: {
      reconnect_enabled: true,
      max_reconnect_delay_ms: 30000,
      heartbeat_interval_ms: 2000,
      message_queue_size: 1000
    }
  };

  let runConfig = clone(DEFAULT_RUN_CONFIG);
  let started = false;
  let wsClient = null;
  let ws = null;
  let authState = null;
  const reconnectKey = resolveReconnectKey();
  let motionPermissionState = "unknown";
  let motionEventsSeen = false;
  let motionWarningTimer = null;
  let cameraPermissionState = "unknown";
  let audioPermissionState = "unknown";
  let gpsPermissionState = "unknown";
  let reconnectState = "stable";
  let lastImuEventMs = 0;
  let lastCameraFrameMs = 0;
  let lastAudioEventMs = 0;
  let lastGpsEventMs = 0;

  let imuLastSent = 0;
  let cameraStream = null;
  let frameTimer = null;
  let canvas = null;
  let ctx2d = null;
  let micStream = null;
  let audioCtx = null;
  let analyser = null;
  let analyserSource = null;
  let pcmProcessor = null;
  let pcmSilenceGain = null;
  let pcmChunkParts = [];
  let pcmChunkSamples = 0;
  let audioTimer = null;
  let deviceTimer = null;
  let batteryManager = null;
  let gpsWatchId = null;
  let lastGpsSent = 0;
  let heartbeatTimer = null;
  let wakeLock = null;
  const deviceMonoOriginWallMs = Date.now() - performance.now();
  let silentAudio = null;

  renderDeviceId();
  renderJoinFields();
  initTheme();
  renderStatus();
  setConnectionUi(false, "Disconnected");
  setJoinStatus("Waiting for join details");

  themeToggleBtn?.addEventListener("click", toggleTheme);

  disconnectBtn?.addEventListener("click", () => {
    if (!wsClient || !started) return;
    if (wsClient.isConnected()) {
      wsClient.disconnect(true);
      setConnectionUi(false, "Disconnected");
      setJoinStatus("Disconnected");
      return;
    }
    void reconnectWithAuth();
  });

  startBtn.addEventListener("click", async () => {
    if (started) return;
    const deviceName = sanitizeDeviceNameInput(deviceNameInput?.value);
    const joinCode = normalizeJoinCode(joinCodeInput?.value);
    if (!deviceName || !joinCode) {
      setJoinStatus("Enter a device name and join code");
      return;
    }
    started = true;
    startBtn.disabled = true;
    setJoinStatus("Authorizing...");
    try {
      authState = await authorizePhoneJoin({ deviceName, joinCode, deviceId: runConfig.device_id });
      runConfig.device_id = authState.deviceId;
      persistReconnectKey(authState.reconnectKey || reconnectKey);
      renderDeviceId();
      setJoinStatus(`Authorized as ${authState.deviceName}`);
      persistJoinFields(deviceName, joinCode);
      await requestPermissionsAndStart();
      connectWs();
      await applyConfig();
    } catch (err) {
      started = false;
      startBtn.disabled = false;
      setJoinStatus(String(err?.message || "Authorization failed"));
    }
  });

  function connectWs() {
    if (!authState?.joinToken) return;
    const wsScheme = location.protocol === "https:" ? "wss" : "ws";
    wsClient = new ResilientWs(`${wsScheme}://${location.host}/ws`, {
      maxReconnectDelayMs: runConfig.network?.max_reconnect_delay_ms || 30000,
      maxQueueSize: runConfig.network?.message_queue_size || 1000,
      maxBufferedBytes: 1024 * 1024,
      onOpen(sock) {
        ws = sock;
        setConnectionUi(true, "Connected");
        setJoinStatus(`Connected as ${authState.deviceName}`);
        queueJson({
          type: "hello",
          role: "phone",
          device_id: runConfig.device_id,
          deviceId: runConfig.device_id,
          deviceName: authState.deviceName,
          join_token: authState.joinToken,
          reconnect_key: reconnectKey,
          capabilities: resolveCapabilities(),
          user_agent: navigator.userAgent
        });
      },
      onClose() {
        ws = null;
        setConnectionUi(false, "Disconnected");
        if (started) setJoinStatus("Disconnected - retrying");
      },
      onMessage(data) {
        if (typeof data !== "string") return;
        let msg = null;
        try { msg = JSON.parse(data); } catch { return; }
        if (!msg) return;
        if (msg.type === "hello_ack" && msg.device_id) {
          reconnectState = msg.renamed_from ? "remapped" : (msg.reused_device_id ? "reused" : "stable");
          runConfig.device_id = String(msg.device_id);
          localStorage.setItem("d3c_phone_device_id", runConfig.device_id);
          if (msg.reconnect_key) persistReconnectKey(String(msg.reconnect_key));
          if (msg.device_name) {
            authState = { ...(authState || {}), deviceName: String(msg.device_name) };
            if (deviceNameInput) deviceNameInput.value = authState.deviceName;
          }
          renderDeviceId();
          renderStatus();
          return;
        }
        if (msg.type === "auth_required") {
          setJoinStatus("Join token expired - tap Start again");
          wsClient?.disconnect(true);
          return;
        }
        if (msg.type === "config") {
          if (msg.device_id && msg.device_id !== runConfig.device_id) return;
          runConfig = mergeRunConfig(msg.runConfig);
          renderStatus();
          applyConfig();
          return;
        }
        if (msg.type === "sync_ping") {
          const t2Mono = getDeviceMonoMs();
          const t2Wall = getDeviceWallUtcMs();
          const t3Mono = getDeviceMonoMs();
          const t3Wall = getDeviceWallUtcMs();
          queueJson({
            type: "sync_pong",
            device_id: runConfig.device_id,
            ping_id: msg.ping_id,
            t1_server_send_ms: Number(msg.t1_server_send_ms || 0),
            t2_device_recv_mono_ms: t2Mono,
            t3_device_send_mono_ms: t3Mono,
            t2_wall_utc_ms: t2Wall,
            t3_wall_utc_ms: t3Wall
          });
          return;
        }
        if (msg.type === "ping") {
          queueJson({
            type: "pong",
            device_id: runConfig.device_id,
            t_device_ms: getDeviceMonoMs(),
            ping_id: msg.ping_id,
            t_ping_recv_ms: getDeviceMonoMs()
          });
        }
      }
    });
    wsClient.connect();
  }

  async function requestPermissionsAndStart() {
    motionPermissionState = "unknown";
    motionEventsSeen = false;
    clearMotionWarningTimer();
    if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
      try {
        const permission = await DeviceMotionEvent.requestPermission();
        motionPermissionState = permission === "granted" ? "granted" : "denied";
      } catch {
        motionPermissionState = "error";
      }
    } else if (typeof DeviceMotionEvent !== "undefined") {
      motionPermissionState = "implicit";
    } else {
      motionPermissionState = "unsupported";
    }
    window.addEventListener("devicemotion", onDeviceMotion);
    scheduleMotionWarning();
    renderStatus();
    if (navigator.getBattery) {
      try { batteryManager = await navigator.getBattery(); } catch {}
    }
    await requestWakeLock();
    startHeartbeat();
  }

  async function applyConfig() {
    if (!started) return;
    const mode = runConfig.streams.camera.mode === "preview" ? "stream" : runConfig.streams.camera.mode;
    if (mode === "off") {
      stopCamera();
      cameraPermissionState = runConfig.streams.camera.record || runConfig.streams.camera.mode !== "off" ? cameraPermissionState : "idle";
    } else {
      if (!cameraStream) {
        try {
          cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
          cameraPermissionState = "granted";
          previewEl.srcObject = cameraStream;
        } catch {
          cameraPermissionState = "denied";
        }
      }
      if (mode === "stream") startFrameLoop();
    }
    await applyAudioConfig();
    applyGpsConfig();
    applyDeviceConfig();
    startHeartbeat();
    renderStatus();
  }

  function onDeviceMotion(ev) {
    if (!started || !runConfig.streams.imu.enabled) return;
    if (!motionEventsSeen) {
      motionEventsSeen = true;
      clearMotionWarningTimer();
      if (motionPermissionState === "unknown") motionPermissionState = "implicit";
      renderStatus();
      if (joinStatus?.textContent === "Waiting for IMU events...") {
        setJoinStatus(`Connected as ${authState?.deviceName || runConfig.device_id}`);
      }
    }
    lastImuEventMs = Date.now();
    const hz = Math.max(1, Number(runConfig.streams.imu.rate_hz || 30));
    const now = performance.now();
    if (now - imuLastSent < 1000 / hz) return;
    imuLastSent = now;
    const a = ev.accelerationIncludingGravity || {};
    const rr = ev.rotationRate || {};
    queueJson({
      type: "imu",
      device_id: runConfig.device_id,
      t_device_ms: now,
      accel_mps2: [Number(a.x || 0), Number(a.y || 0), Number(a.z || 0)],
      gyro_rads: [
        Number(rr.alpha || 0) * Math.PI / 180,
        Number(rr.beta || 0) * Math.PI / 180,
        Number(rr.gamma || 0) * Math.PI / 180
      ]
    });
  }

  function startFrameLoop() {
    stopFrameLoop();
    if (!previewEl.videoWidth || !previewEl.videoHeight) {
      setTimeout(startFrameLoop, 300);
      return;
    }
    if (!canvas) {
      canvas = document.createElement("canvas");
      ctx2d = canvas.getContext("2d", { alpha: false });
    }
    frameTimer = setInterval(async () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (runConfig.streams.camera.mode !== "stream") return;
      const w = previewEl.videoWidth;
      const h = previewEl.videoHeight;
      if (!w || !h) return;
      const down = Math.max(1, Number(runConfig.streams.camera.downsample_factor || 1));
      canvas.width = Math.max(1, Math.floor(w / down));
      canvas.height = Math.max(1, Math.floor(h / down));
      ctx2d.drawImage(previewEl, 0, 0, canvas.width, canvas.height);
      const lightingScore = estimateLighting(ctx2d, canvas.width, canvas.height);
      const q = Math.max(0.1, Math.min(0.95, Number(runConfig.streams.camera.jpeg_q || 0.6)));
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", q));
      if (!blob) return;
      const buffer = await blob.arrayBuffer();
      lastCameraFrameMs = Date.now();
      queueJson({
        type: "camera_header",
        device_id: runConfig.device_id,
        t_device_ms: getDeviceMonoMs(),
        frame_id: "phone_camera",
        format: "jpeg",
        lighting_score: lightingScore
      });
      wsClient?.sendBinary(buffer);
    }, Math.max(50, Math.floor(1000 / Math.max(1, Number(runConfig.streams.camera.fps || 10)))));
  }

  function stopFrameLoop() {
    if (!frameTimer) return;
    clearInterval(frameTimer);
    frameTimer = null;
  }

  function stopCamera() {
    stopFrameLoop();
    if (!cameraStream) return;
    for (const t of cameraStream.getTracks()) t.stop();
    cameraStream = null;
    previewEl.srcObject = null;
  }

  async function applyAudioConfig() {
    if (!runConfig.streams.audio?.enabled) {
      flushPcmChunk(audioCtx?.sampleRate || 48000);
      stopAudioLoop();
      if (micStream) {
        for (const t of micStream.getTracks()) t.stop();
        micStream = null;
      }
      if (audioCtx) {
        try { await audioCtx.close(); } catch {}
        audioCtx = null;
        analyserSource = null;
        analyser = null;
        pcmProcessor = null;
        pcmSilenceGain = null;
        pcmChunkParts = [];
        pcmChunkSamples = 0;
      }
      return;
    }
    if (!micStream) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        audioPermissionState = "granted";
      } catch {
        audioPermissionState = "denied";
        renderStatus();
        return;
      }
    }
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyserSource = audioCtx.createMediaStreamSource(micStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyserSource.connect(analyser);

      // Raw PCM capture for server-side WAV writing.
      pcmProcessor = audioCtx.createScriptProcessor(2048, 1, 1);
      pcmSilenceGain = audioCtx.createGain();
      pcmSilenceGain.gain.value = 0;
      analyserSource.connect(pcmProcessor);
      pcmProcessor.connect(pcmSilenceGain);
      pcmSilenceGain.connect(audioCtx.destination);
      pcmProcessor.onaudioprocess = onPcmProcess;
    }
    startAudioLoop();
  }

  function startAudioLoop() {
    stopAudioLoop();
    const hz = Math.max(1, Number(runConfig.streams.audio?.rate_hz || 10));
    const arr = new Float32Array(analyser.fftSize);
    audioTimer = setInterval(() => {
      if (!analyser) return;
      analyser.getFloatTimeDomainData(arr);
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < arr.length; i += 1) {
        const v = arr[i];
        const a = Math.abs(v);
        sum += v * v;
        if (a > peak) peak = a;
      }
      queueJson({
        type: "audio",
        device_id: runConfig.device_id,
        t_device_ms: getDeviceMonoMs(),
        amplitude: Number(peak.toFixed(4)),
        noise_level: Number(Math.sqrt(sum / arr.length).toFixed(4))
      });
      lastAudioEventMs = Date.now();
    }, Math.floor(1000 / hz));
  }

  function stopAudioLoop() {
    if (!audioTimer) return;
    clearInterval(audioTimer);
    audioTimer = null;
  }

  function onPcmProcess(ev) {
    if (!runConfig.streams.audio?.enabled) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const input = ev.inputBuffer.getChannelData(0);
    if (!input || !input.length) return;
    const int16 = new Int16Array(input.length);
    for (let i = 0; i < input.length; i += 1) {
      const s = Math.max(-1, Math.min(1, input[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    pcmChunkParts.push(int16);
    pcmChunkSamples += int16.length;
    if (pcmChunkSamples < 8192) return;
    flushPcmChunk(ev.inputBuffer.sampleRate);
  }

  function flushPcmChunk(sampleRate) {
    if (!pcmChunkSamples) return;
    const merged = new Int16Array(pcmChunkSamples);
    let offset = 0;
    for (const part of pcmChunkParts) {
      merged.set(part, offset);
      offset += part.length;
    }
    const b64 = arrayBufferToBase64(merged.buffer);
    queueJson({
      type: "audio_pcm",
      device_id: runConfig.device_id,
      t_device_ms: getDeviceMonoMs(),
      sample_rate: Number(sampleRate || audioCtx?.sampleRate || 48000),
      channels: 1,
      encoding: "pcm_s16le",
      data_b64: b64
    });
    pcmChunkParts = [];
    pcmChunkSamples = 0;
  }


  function applyGpsConfig() {
    const g = runConfig.streams.gps;
    if (!g?.enabled) {
      if (gpsWatchId != null && navigator.geolocation) {
        navigator.geolocation.clearWatch(gpsWatchId);
      }
      gpsWatchId = null;
      return;
    }
    if (!navigator.geolocation) return;
    if (gpsWatchId != null) return;
    gpsWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        gpsPermissionState = "granted";
        const hz = Math.max(0.2, Number(runConfig.streams.gps?.rate_hz || 1));
        const now = performance.now();
        if (now - lastGpsSent < 1000 / hz) return;
        lastGpsSent = now;
        lastGpsEventMs = Date.now();
        queueJson({
          type: "gps",
          device_id: runConfig.device_id,
          t_device_ms: now,
          lat: Number(pos.coords?.latitude || 0),
          lon: Number(pos.coords?.longitude || 0),
          accuracy_m: Number(pos.coords?.accuracy ?? -1),
          speed_mps: Number(pos.coords?.speed ?? -1),
          heading_deg: Number(pos.coords?.heading ?? -1),
          altitude_m: Number(pos.coords?.altitude ?? -1)
        });
      },
      () => {
        gpsPermissionState = "denied";
        renderStatus();
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
    );
  }
  function applyDeviceConfig() {
    if (!runConfig.streams.device?.enabled) {
      if (deviceTimer) clearInterval(deviceTimer);
      deviceTimer = null;
      return;
    }
    if (deviceTimer) clearInterval(deviceTimer);
    const hz = Math.max(1, Number(runConfig.streams.device?.rate_hz || 1));
    deviceTimer = setInterval(() => {
      queueJson({
        type: "device",
        device_id: runConfig.device_id,
        t_device_ms: getDeviceMonoMs(),
        battery_level: batteryManager ? Number((batteryManager.level * 100).toFixed(1)) : -1,
        charging: batteryManager ? !!batteryManager.charging : false,
        orientation: String(screen.orientation?.type || "unknown")
      });
    }, Math.floor(1000 / hz));
  }

  function startHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    const interval = Math.max(500, Number(runConfig.network?.heartbeat_interval_ms || 2000));
    heartbeatTimer = setInterval(() => {
      queueJson({
        type: "heartbeat",
        device_id: runConfig.device_id,
        t_device_ms: getDeviceMonoMs(),
        timestamp: Date.now()
      });
    }, interval);
  }

  async function requestWakeLock() {
    try {
      if ("wakeLock" in navigator) {
        wakeLock = await navigator.wakeLock.request("screen");
        return;
      }
    } catch {}
    startSilentAudio();
  }

  function startSilentAudio() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.00001;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      silentAudio = { ctx, osc, gain };
    } catch {}
  }

  function renderStatus() {
    const s = runConfig.streams;
    statusList.innerHTML = "";
    renderReadiness();
    renderGuidance();

    const imuLabel = s.imu.enabled ? `ON ${s.imu.rate_hz} Hz` : "OFF";
    const camLabel = String(s.camera.mode || "off").toUpperCase();
    const audLabel = s.audio.enabled ? "ON" : "OFF";

    const lines = [
      `IMU stream: ${imuLabel}`,
      `IMU permission: ${describeMotionStatus()}`,
      `Camera: ${camLabel} @ ${s.camera.fps} FPS`,
      `Audio stream: ${audLabel}`,
      `GPS stream: ${s.gps.enabled ? "ON " + s.gps.rate_hz + " Hz" : "OFF"}`,
      `Recording flags: IMU ${s.imu.record ? "ON" : "OFF"}, CAM ${s.camera.record ? "ON" : "OFF"}, AUD ${s.audio.record ? "ON" : "OFF"}, GPS ${s.gps.record ? "ON" : "OFF"}`
    ];

    for (const line of lines) {
      const li = document.createElement("li");
      li.textContent = line;
      statusList.appendChild(li);
    }

    if (phoneCameraMode) phoneCameraMode.textContent = camLabel;
    if (phoneAudioMode) phoneAudioMode.textContent = audLabel;
    setSignalState(phoneCameraCard, s.camera.mode === "stream" ? "ok" : "bad");
    setSignalState(phoneAudioCard, s.audio.enabled ? "ok" : "warn");
  }

  function renderReadiness() {
    if (!phoneReadinessList || !phoneReadySummary) return;
    const now = Date.now();
    const items = [
      readinessItem("Authorized", !!authState?.joinToken, authState?.joinToken ? "Join token issued" : "Tap Start to authorize"),
      readinessItem("WebSocket", !!(ws && ws.readyState === WebSocket.OPEN), ws && ws.readyState === WebSocket.OPEN ? "Connected to server" : "Waiting for connection"),
      readinessItem("Reconnect Identity", reconnectState !== "remapped", reconnectState === "reused" ? "Previous device identity reused" : reconnectState === "remapped" ? "Server assigned a new logical device" : "Stable local identity"),
      readinessItem("IMU", !runConfig.streams.imu.enabled || motionEventsSeen, !runConfig.streams.imu.enabled ? "Disabled in session config" : motionEventsSeen ? "Motion events flowing" : describeMotionStatus()),
      readinessItem("Camera", runConfig.streams.camera.mode === "off" || (cameraPermissionState === "granted" && ageFresh(lastCameraFrameMs, now, 6000)), runConfig.streams.camera.mode === "off" ? "Disabled in session config" : cameraPermissionState === "granted" ? (ageFresh(lastCameraFrameMs, now, 6000) ? "Frames streaming" : "Permission granted, waiting for frames") : cameraPermissionState),
      readinessItem("Audio", !runConfig.streams.audio.enabled || (audioPermissionState === "granted" && ageFresh(lastAudioEventMs, now, 6000)), !runConfig.streams.audio.enabled ? "Disabled in session config" : audioPermissionState === "granted" ? (ageFresh(lastAudioEventMs, now, 6000) ? "Levels streaming" : "Permission granted, waiting for audio") : audioPermissionState),
      readinessItem("GPS", !runConfig.streams.gps.enabled || (gpsPermissionState === "granted" && ageFresh(lastGpsEventMs, now, 12000)), !runConfig.streams.gps.enabled ? "Disabled in session config" : gpsPermissionState === "granted" ? (ageFresh(lastGpsEventMs, now, 12000) ? "Fix updates flowing" : "Permission granted, waiting for GPS fix") : gpsPermissionState)
    ];

    const readyCount = items.filter((item) => item.ok).length;
    phoneReadySummary.textContent = `${readyCount}/${items.length} checks ready`;
    phoneReadinessList.innerHTML = "";
    for (const item of items) {
      const li = document.createElement("li");
      li.className = `phone-check-item ${item.ok ? "ok" : "warn"}`;
      li.innerHTML = `<strong>${item.label}</strong><span>${item.detail}</span>`;
      phoneReadinessList.appendChild(li);
    }
  }

  function renderGuidance() {
    if (!phoneGuidanceList) return;
    const guidance = [
      "Use Safari on iPhone if motion sensors do not start.",
      "Keep this page in the foreground while recording.",
      "Leave the screen awake and avoid Low Power Mode.",
      "If reconnect remaps the device, refresh once and reconnect."
    ];
    if (motionPermissionState === "denied") guidance.unshift("Motion access is denied. Enable Motion & Orientation access and reload.");
    if (runConfig.streams.camera.mode !== "off" && cameraPermissionState === "denied") guidance.unshift("Camera access was denied. Allow camera access to stream video.");
    if (runConfig.streams.audio.enabled && audioPermissionState === "denied") guidance.unshift("Microphone access was denied. Allow microphone access to capture audio.");
    if (runConfig.streams.gps.enabled && gpsPermissionState === "denied") guidance.unshift("Location access was denied. Allow location access for GPS capture.");
    phoneGuidanceList.innerHTML = "";
    for (const line of guidance.slice(0, 5)) {
      const li = document.createElement("li");
      li.textContent = line;
      phoneGuidanceList.appendChild(li);
    }
  }

  function renderDeviceId() {
    deviceIdPill.textContent = runConfig.device_id;
  }

  function renderJoinFields() {
    const savedName = localStorage.getItem("d3c_phone_device_name") || "";
    const savedCode = localStorage.getItem("d3c_phone_join_code") || "";
    if (deviceNameInput) deviceNameInput.value = savedName;
    if (joinCodeInput) joinCodeInput.value = savedCode;
  }

  function persistJoinFields(deviceName, joinCode) {
    localStorage.setItem("d3c_phone_device_name", deviceName);
    localStorage.setItem("d3c_phone_join_code", joinCode);
  }

  function setJoinStatus(text) {
    if (joinStatus) joinStatus.textContent = text;
  }

    function setConnectionUi(isConnected, shortLabel) {
    if (connStatus) {
      connStatus.textContent = isConnected ? "Connected" : "Disconnected";
    }
    if (phoneConnText) {
      phoneConnText.textContent = shortLabel || (isConnected ? "Connected" : "Disconnected");
    }
    setSignalState(phoneConnCard, isConnected ? "ok" : "bad");
    if (disconnectBtn) disconnectBtn.textContent = isConnected ? "Disconnect" : "Reconnect";
  }

  function setSignalState(el, mode) {
    if (!el) return;
    el.classList.remove("is-ok", "is-warn", "is-bad");
    if (mode === "ok") el.classList.add("is-ok");
    else if (mode === "warn") el.classList.add("is-warn");
    else el.classList.add("is-bad");
  }
function queueJson(obj) {
    wsClient?.sendJson(obj);
  }

  function getDeviceMonoMs() {
    return performance.now();
  }

  function getDeviceWallUtcMs() {
    return Date.now();
  }

  function estimateLighting(ctx, w, h) {
    const sampleW = Math.max(1, Math.floor(w / 16));
    const sampleH = Math.max(1, Math.floor(h / 16));
    const pixels = ctx.getImageData(0, 0, sampleW, sampleH).data;
    let sum = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      sum += 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
    }
    return Number((sum / (pixels.length / 4) / 255).toFixed(3));
  }

  function resolveDeviceId() {
    const qp = new URLSearchParams(location.search);
    const qid = (qp.get("device_id") || "").trim();
    if (qid) return qid;
    const key = "d3c_phone_device_id";
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const generated = `iphone-${createUuidV4()}`;
    localStorage.setItem(key, generated);
    return generated;
  }

  function resolveReconnectKey() {
    const existing = localStorage.getItem(RECONNECT_KEY_STORAGE);
    if (existing) return existing;
    const generated = `phone-${createUuidV4()}`;
    localStorage.setItem(RECONNECT_KEY_STORAGE, generated);
    return generated;
  }

  function persistReconnectKey(value) {
    const normalized = String(value || "").trim();
    if (!normalized) return;
    localStorage.setItem(RECONNECT_KEY_STORAGE, normalized);
  }

  async function authorizePhoneJoin({ deviceName, joinCode, deviceId }) {
    const res = await fetch("/api/phone/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_name: deviceName,
        join_code: joinCode,
        device_id: deviceId,
        reconnect_key: reconnectKey
      })
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload?.ok) {
      throw new Error(formatAuthError(payload?.error || "authorization_failed"));
    }
    return {
      joinToken: String(payload.join_token || ""),
      expiresAtMs: Number(payload.expires_at_ms || 0),
      deviceName: String(payload.device_name || deviceName),
      deviceId: String(payload.device_id || deviceId || runConfig.device_id),
      reconnectKey: String(payload.reconnect_key || reconnectKey)
    };
  }

  async function reconnectWithAuth() {
    if (!started) return;
    const deviceName = sanitizeDeviceNameInput(deviceNameInput?.value || authState?.deviceName);
    const joinCode = normalizeJoinCode(joinCodeInput?.value);
    if (!deviceName || !joinCode) {
      setJoinStatus("Enter a device name and join code");
      return;
    }
    setJoinStatus("Authorizing...");
    try {
      authState = await authorizePhoneJoin({ deviceName, joinCode, deviceId: runConfig.device_id });
      runConfig.device_id = authState.deviceId;
      persistReconnectKey(authState.reconnectKey || reconnectKey);
      renderDeviceId();
      setJoinStatus(`Authorized as ${authState.deviceName}`);
      persistJoinFields(deviceName, joinCode);
      wsClient?.reconnect();
      setConnectionUi(false, "Connecting...");
    } catch (err) {
      setJoinStatus(String(err?.message || "Authorization failed"));
    }
  }

  function normalizeJoinCode(value) {
    return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  function sanitizeDeviceNameInput(value) {
    return String(value || "").trim().replace(/\s+/g, " ").slice(0, 40);
  }

  function formatAuthError(code) {
    if (code === "device_name_required") return "Device name is required";
    if (code === "join_code_required") return "Join code is required";
    if (code === "invalid_join_code") return "Join code was rejected";
    return "Authorization failed";
  }

    function resolveDeviceName() {
    const manual = sanitizeDeviceNameInput(deviceNameInput?.value);
    if (manual) return manual;
    const model = navigator.platform || "iPhone";
    const short = String(runConfig.device_id || "node").slice(0, 8);
    return `${model}-${short}`;
  }

  function resolveCapabilities() {
    return {
      imu: typeof DeviceMotionEvent !== "undefined",
      camera: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      audio: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      gps: !!navigator.geolocation,
      battery: !!navigator.getBattery,
      wake_lock: "wakeLock" in navigator
    };
  }

  function createUuidV4() {
    if (window.crypto && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
function mergeRunConfig(input) {
    const merged = clone(DEFAULT_RUN_CONFIG);
    if (!input || typeof input !== "object") return merged;
    merged.device_id = typeof input.device_id === "string" ? input.device_id : merged.device_id;
    const inS = input.streams || {};
    for (const key of Object.keys(merged.streams)) merged.streams[key] = { ...merged.streams[key], ...(inS[key] || {}) };
    merged.network = { ...merged.network, ...(input.network || {}) };
    return merged;
  }

  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  function arrayBufferToBase64(buffer) {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function initTheme() {
    const saved = localStorage.getItem("phonesense_phone_theme");
    if (saved === "dark" || saved === "light") {
      applyTheme(saved);
      return;
    }
    applyTheme("dark");
  }

  function toggleTheme() {
    const current = document.body.getAttribute("data-theme") || "light";
    applyTheme(current === "light" ? "dark" : "light");
  }

  function applyTheme(theme) {
    document.body.setAttribute("data-theme", theme);
    localStorage.setItem("phonesense_phone_theme", theme);
    if (themeToggleBtn) {
      themeToggleBtn.textContent = theme === "light" ? "Dark Mode" : "Light Mode";
    }
  }

  class ResilientWs {
    constructor(url, opts) {
      this.url = url;
      this.opts = opts;
      this.ws = null;
      this.reconnectAttempts = 0;
      this.queue = [];
      this.closedByUser = false;
    }
    connect() {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
      if (this.closedByUser) return;
      this.ws = new WebSocket(this.url);
      this.ws.binaryType = "arraybuffer";
      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.opts.onOpen?.(this.ws);
        this.flushQueue();
      };
      this.ws.onclose = () => {
        this.opts.onClose?.();
        if (this.closedByUser) return;
        if (runConfig.network?.reconnect_enabled === false) return;
        const base = 1000;
        const max = this.opts.maxReconnectDelayMs || 30000;
        const delay = Math.min(max, Math.round(base * Math.pow(1.5, this.reconnectAttempts++)));
        setTimeout(() => this.connect(), delay + Math.floor(Math.random() * 250));
      };
      this.ws.onerror = () => {};
      this.ws.onerror = () => {
        setConnectionUi(false, "Error");
      };
      this.ws.onmessage = (ev) => this.opts.onMessage?.(ev.data);
    }
    sendJson(obj) {
      const text = JSON.stringify(obj);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(text);
        return;
      }
      const maxQ = this.opts.maxQueueSize || 1000;
      if (this.queue.length >= maxQ) this.queue.shift();
      this.queue.push(text);
    }
    sendBinary(buffer) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
      const maxBufferedBytes = this.opts.maxBufferedBytes || (1024 * 1024);
      if (this.ws.bufferedAmount > maxBufferedBytes) return false;
      this.ws.send(buffer);
      return true;
    }
    disconnect(byUser = true) {
      this.closedByUser = !!byUser;
      if (!this.ws) return;
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    reconnect() {
      this.closedByUser = false;
      this.connect();
    }
    isConnected() {
      return !!(this.ws && this.ws.readyState === WebSocket.OPEN);
    }
    flushQueue() {
      while (this.queue.length && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(this.queue.shift());
      }
    }
  }

  function scheduleMotionWarning() {
    clearMotionWarningTimer();
    if (!runConfig.streams.imu.enabled) return;
    motionWarningTimer = setTimeout(() => {
      if (motionEventsSeen || !runConfig.streams.imu.enabled) return;
      renderStatus();
      if (motionPermissionState === "denied") {
        setJoinStatus("Motion access denied. Allow Motion & Orientation access and try again.");
        return;
      }
      if (motionPermissionState === "unsupported") {
        setJoinStatus("This browser is not exposing motion sensors.");
        return;
      }
      setJoinStatus("Waiting for IMU events...");
    }, 4000);
  }

  function clearMotionWarningTimer() {
    if (!motionWarningTimer) return;
    clearTimeout(motionWarningTimer);
    motionWarningTimer = null;
  }

  function describeMotionStatus() {
    if (!runConfig.streams.imu.enabled) return "OFF";
    if (motionEventsSeen) return "OK";
    if (motionPermissionState === "granted") return "granted, waiting";
    if (motionPermissionState === "implicit") return "waiting";
    if (motionPermissionState === "denied") return "denied";
    if (motionPermissionState === "unsupported") return "unsupported";
    if (motionPermissionState === "error") return "request failed";
    return "unknown";
  }

  function readinessItem(label, ok, detail) {
    return { label, ok: !!ok, detail: String(detail || (ok ? "ready" : "waiting")) };
  }

  function ageFresh(ts, now, maxAgeMs) {
    return Number(ts || 0) > 0 && (now - Number(ts || 0)) <= maxAgeMs;
  }
})();
