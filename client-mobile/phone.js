(() => {
  const startBtn = document.getElementById("startBtn");
  const themeToggleBtn = document.getElementById("phoneThemeToggleBtn");
  const connStatus = document.getElementById("connStatus");
  const deviceIdPill = document.getElementById("deviceIdPill");
  const statusList = document.getElementById("statusList");
  const previewEl = document.getElementById("preview");

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
  let silentAudio = null;

  renderDeviceId();
  initTheme();
  renderStatus();

  themeToggleBtn?.addEventListener("click", toggleTheme);

  startBtn.addEventListener("click", async () => {
    if (started) return;
    started = true;
    startBtn.disabled = true;
    await requestPermissionsAndStart();
    await applyConfig();
  });

  function connectWs() {
    wsClient = new ResilientWs(`wss://${location.host}/ws`, {
      maxReconnectDelayMs: runConfig.network?.max_reconnect_delay_ms || 30000,
      maxQueueSize: runConfig.network?.message_queue_size || 1000,
      maxBufferedBytes: 1024 * 1024,
      onOpen(sock) {
        ws = sock;
        connStatus.textContent = "Connected (ws open)";
        queueJson({
          type: "hello",
          role: "phone",
          device_id: runConfig.device_id,
          user_agent: navigator.userAgent
        });
      },
      onClose() {
        connStatus.textContent = "Disconnected (ws closed)";
      },
      onMessage(data) {
        if (typeof data !== "string") return;
        let msg = null;
        try { msg = JSON.parse(data); } catch { return; }
        if (!msg) return;
        if (msg.type === "hello_ack" && msg.device_id) {
          runConfig.device_id = String(msg.device_id);
          localStorage.setItem("phonesense_phone_device_id", runConfig.device_id);
          renderDeviceId();
          return;
        }
        if (msg.type === "config") {
          if (msg.device_id && msg.device_id !== runConfig.device_id) return;
          runConfig = mergeRunConfig(msg.runConfig);
          renderStatus();
          applyConfig();
          return;
        }
        if (msg.type === "ping") {
          queueJson({
            type: "pong",
            device_id: runConfig.device_id,
            t_device_ms: performance.now(),
            ping_id: msg.ping_id,
            t_ping_recv_ms: performance.now()
          });
        }
      }
    });
    wsClient.connect();
  }

  async function requestPermissionsAndStart() {
    if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
      try { await DeviceMotionEvent.requestPermission(); } catch {}
    }
    window.addEventListener("devicemotion", onDeviceMotion);
    if (navigator.getBattery) {
      try { batteryManager = await navigator.getBattery(); } catch {}
    }
    await requestWakeLock();
    startHeartbeat();
  }

  async function applyConfig() {
    if (!started) return;
    const mode = runConfig.streams.camera.mode;
    if (mode === "off") {
      stopCamera();
    } else {
      if (!cameraStream) {
        try {
          cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
          previewEl.srcObject = cameraStream;
        } catch {}
      }
      if (mode === "preview") stopFrameLoop();
      if (mode === "stream") startFrameLoop();
    }
    await applyAudioConfig();
    applyDeviceConfig();
    startHeartbeat();
  }

  function onDeviceMotion(ev) {
    if (!started || !runConfig.streams.imu.enabled) return;
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
      queueJson({
        type: "camera_header",
        device_id: runConfig.device_id,
        t_device_ms: performance.now(),
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
      try { micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); } catch { return; }
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
        t_device_ms: performance.now(),
        amplitude: Number(peak.toFixed(4)),
        noise_level: Number(Math.sqrt(sum / arr.length).toFixed(4))
      });
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
      t_device_ms: performance.now(),
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
        const hz = Math.max(0.2, Number(runConfig.streams.gps?.rate_hz || 1));
        const now = performance.now();
        if (now - lastGpsSent < 1000 / hz) return;
        lastGpsSent = now;
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
      () => {},
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
        t_device_ms: performance.now(),
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
        t_device_ms: performance.now(),
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
    const lines = [
      `IMU: enabled=${s.imu.enabled} rate=${s.imu.rate_hz}Hz record=${s.imu.record}`,
      `Camera: mode=${s.camera.mode} fps=${s.camera.fps} q=${s.camera.jpeg_q} record=${s.camera.record} encode=${s.camera.encode_timing || "post_session"}`,
      `GPS: enabled=${s.gps.enabled} record=${s.gps.record}`,
      `Audio: enabled=${s.audio.enabled} rate=${s.audio.rate_hz}Hz record=${s.audio.record}`,
      `Device: enabled=${s.device.enabled} rate=${s.device.rate_hz}Hz record=${s.device.record}`,
      `Fusion: enabled=${s.fusion.enabled} record=${s.fusion.record}`,
      `Events: record=${s.events.record}`,
      `Net: enabled=${s.net.enabled} record=${s.net.record}`
    ];
    for (const line of lines) {
      const li = document.createElement("li");
      li.textContent = line;
      statusList.appendChild(li);
    }
  }

  function renderDeviceId() {
    deviceIdPill.textContent = `device: ${runConfig.device_id}`;
  }

  function queueJson(obj) {
    wsClient?.sendJson(obj);
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
    const key = "phonesense_phone_device_id";
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const generated = `iphone-${Math.random().toString(36).slice(2, 6)}`;
    localStorage.setItem(key, generated);
    return generated;
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
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    applyTheme(prefersDark ? "dark" : "light");
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
        if (runConfig.network?.reconnect_enabled === false) return;
        const base = 1000;
        const max = this.opts.maxReconnectDelayMs || 30000;
        const delay = Math.min(max, Math.round(base * Math.pow(1.5, this.reconnectAttempts++)));
        setTimeout(() => this.connect(), delay + Math.floor(Math.random() * 250));
      };
      this.ws.onerror = () => {};
      this.ws.onerror = () => {
        connStatus.textContent = "Disconnected (ws error)";
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
    flushQueue() {
      while (this.queue.length && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(this.queue.shift());
      }
    }
  }

  connectWs();
})();


