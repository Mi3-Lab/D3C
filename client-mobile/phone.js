(() => {
  const startBtn = document.getElementById("startBtn");
  const disconnectBtn = document.getElementById("disconnectBtn");
  const connStatus = document.getElementById("connStatus");
  const deviceNameInput = document.getElementById("deviceNameInput");
  const joinCodeInput = document.getElementById("joinCodeInput");
  const joinValidation = document.getElementById("joinValidation");
  const joinStatus = document.getElementById("joinStatus");
  const previewEl = document.getElementById("preview");
  let carViewOverlayEl = null;
  let carViewVideoEl = null;
  let carViewHudEl = null;
  let carViewStateEl = null;
  let carViewScoreEl = null;
  let carViewMetaEl = null;
  let carViewDetailEl = null;
  let carViewCameraStateEl = null;
  let carViewActive = false;
  let carViewStatusTimer = null;
  const deviceIdentityCard = document.getElementById("deviceIdentityCard");
  const deviceIdentityName = document.getElementById("deviceIdentityName");
  const deviceIdentityType = document.getElementById("deviceIdentityType");
  const primaryActionArea = document.getElementById("primaryActionArea");
  const phoneWorkzoneCard = document.getElementById("phoneWorkzoneCard");
  const phoneWorkzoneTitle = document.getElementById("phoneWorkzoneTitle");
  const phoneWorkzoneBadge = document.getElementById("phoneWorkzoneBadge");
  const phoneWorkzoneMessage = document.getElementById("phoneWorkzoneMessage");
  const phoneWorkzoneMeta = document.getElementById("phoneWorkzoneMeta");
  const phoneWorkzoneMetrics = document.getElementById("phoneWorkzoneMetrics");
  const phoneReadySummary = document.getElementById("phoneReadySummary");
  const phoneReadyMissing = document.getElementById("phoneReadyMissing");
  const phoneReadinessList = document.getElementById("phoneReadinessList");
  const phonePermissionActions = document.getElementById("phonePermissionActions");
  const phoneFleetOverviewDetails = document.getElementById("phoneFleetOverviewDetails");
  const phoneFleetOverviewBadge = document.getElementById("phoneFleetOverviewBadge");
  const phoneFleetOverviewMeta = document.getElementById("phoneFleetOverviewMeta");
  const phoneFleetOverviewViewport = document.getElementById("phoneFleetOverviewViewport");
  const phoneFleetOverviewCanvas = document.getElementById("phoneFleetOverviewCanvas");
  const phoneFleetOverviewStatus = document.getElementById("phoneFleetOverviewStatus");
  const phoneFleetOverviewLegend = document.getElementById("phoneFleetOverviewLegend");
  const cameraFlipBtn = document.getElementById("cameraFlipBtn");
  const cameraPreviewBadge = document.getElementById("cameraPreviewBadge");
  const cameraPreviewFps = document.getElementById("cameraPreviewFps");
  const cameraPreviewMeta = document.getElementById("cameraPreviewMeta");
  const permissionRefreshModal = document.getElementById("permissionRefreshModal");
  const permissionRefreshModalTitle = document.getElementById("permissionRefreshModalTitle");
  const permissionRefreshModalMessage = document.getElementById("permissionRefreshModalMessage");
  const permissionRefreshModalMeta = document.getElementById("permissionRefreshModalMeta");
  const permissionRefreshModalAction = document.getElementById("permissionRefreshModalAction");
  const permissionRefreshModalRefresh = document.getElementById("permissionRefreshModalRefresh");
  const permissionRefreshModalDismiss = document.getElementById("permissionRefreshModalDismiss");
  const RECONNECT_KEY_STORAGE = "d3c_phone_reconnect_key";
  const PHONE_OVERVIEW_OPEN_KEY = "d3c_phone_fleet_overview_open";
  const PREVIEW_ICE_SERVERS = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
  const GPS_LIVE_TILE_SIZE = 256;
  const GPS_LIVE_TILE_TEMPLATE = "https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png";
  const GPS_LIVE_STALE_MS = 15000;
  const GPS_LIVE_TRAIL_MAX_AGE_MS = 20 * 60 * 1000;
  const GPS_LIVE_TRAIL_MAX_POINTS = 2400;
  const GPS_LIVE_DRAW_MAX_POINTS = 700;
  const GPS_LIVE_COLORS = ["#ff6b6b", "#4dabf7", "#51cf66", "#fcc419", "#b197fc", "#63e6be", "#ffa94d", "#f783ac"];
  const CAMERA_VIDEO_CHUNK_TIMESLICE_MS = 1000;
  const CAMERA_BINARY_BUFFER_LIMIT_BYTES = 8 * 1024 * 1024;

  const DEFAULT_RUN_CONFIG = {
    device_id: resolveDeviceId(),
    streams: {
      imu: { enabled: true, rate_hz: 30, record: false },
      camera: { mode: "off", fps: 10, jpeg_q: 0.6, record: false, record_mode: "both", video_fps: 30 },
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
  let cameraFacingMode = "environment";
  let reconnectState = "stable";
  let sessionRecordingActive = false;
  let workzoneAlertsEnabled = true;
  let latestOwnGps = null;
  let hasSeenRecordingState = false;
  let joinCodeTouched = false;
  let lastImuEventMs = 0;
  let lastCameraFrameMs = 0;
  let lastAudioEventMs = 0;
  let lastGpsEventMs = 0;

  let imuLastSent = 0;
  let cameraStream = null;
  let frameTimer = null;
  let cameraVideoRecorder = null;
  let cameraVideoRecorderMimeType = "";
  let cameraVideoRecorderStream = null;
  let cameraVideoRecorderStartDeviceMs = 0;
  let cameraVideoRecorderLastChunkDeviceMs = 0;
  let cameraVideoRecorderChunkIndex = 0;
  let cameraVideoRecorderFallback = false;
  let cameraVideoRecorderStopPromise = null;
  let cameraVideoRecorderSendChain = Promise.resolve();
  let cameraVideoRecorderSyncChain = Promise.resolve();
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
  let lastPcmChunkMs = 0;
  let pcmRestarting = false;
  let audioTimer = null;
  let deviceTimer = null;
  let batteryManager = null;
  let gpsWatchId = null;
  let lastGpsSent = 0;
  let heartbeatTimer = null;
  let wakeLock = null;
  const deviceMonoOriginWallMs = Date.now() - performance.now();
  let silentAudio = null;
  let iosSpeakerPrimerEl = null;
  let alertMediaAnchorEl = null;
  let alertMediaAnchorUrl = "";
  let alertAudioCtx = null;
  let alertAudioMasterGain = null;
  let alertAudioCompressor = null;
  let alertAudioGraphReady = false;
  let alertAudioWarmup = null;
  let alertFeedbackText = "";
  let alertFeedbackTone = "muted";
  let alertFeedbackTimer = null;
  let permissionRefreshNotice = null;
  let permissionRefreshBusy = false;
  let permissionRefreshStatusText = "";
  let alertCooldownTimer = null;
  let lastGenericAlertSentAtMs = 0;
  let lastWorkzoneAlertSentAtMs = 0;
  let lastAlertPlayedAtMs = 0;
  let lastWorkzoneAlertPlayedAtMs = 0;
  let pendingAlertReplay = null;
  let pendingAlertReplayTimer = null;
  let workzoneSpeechPrimed = false;
  let workzoneSpeechPrimeInFlight = null;
  let workzoneVoiceWaitInFlight = null;
  let activeSpeechUtterance = null;
  let activeSpeechResumeTimer = null;
  let suppressSelfWorkzonePlaybackUntilMs = 0;
  let suppressSelfGenericAlertUntilMs = 0;
  let latestWorkzoneVisual = null;
  const recentFleetAlertIds = new Map();
  const recentWorkzoneAnnouncementKeys = new Map();
  const workzoneOverviewStateByDevice = new Map();
  let workzoneOverviewBaselineReady = false;
  const previewPeers = new Map();
  let lastPreviewStatusSent = "";
  let fleetOverview = { devices: [], generated_at_ms: 0 };
  const fleetOverviewTrailCache = new Map();
  const fleetOverviewTileCache = new Map();
  let fleetOverviewRenderPending = false;
  let fleetOverviewResizeObserver = null;

  renderDeviceIdentity();
  renderJoinFields();
  renderJoinValidation();
  document.body.setAttribute("data-theme", "dark");
  renderStatus();
  setConnectionUi(false, "Disconnected");
  setJoinStatus("Enter join code");
  if (phoneFleetOverviewDetails) {
    phoneFleetOverviewDetails.open = localStorage.getItem(PHONE_OVERVIEW_OPEN_KEY) === "1";
    phoneFleetOverviewDetails.addEventListener("toggle", () => {
      localStorage.setItem(PHONE_OVERVIEW_OPEN_KEY, phoneFleetOverviewDetails.open ? "1" : "0");
      scheduleFleetOverviewRender();
    });
  }
  if (typeof ResizeObserver === "function" && phoneFleetOverviewViewport) {
    fleetOverviewResizeObserver = new ResizeObserver(() => scheduleFleetOverviewRender());
    fleetOverviewResizeObserver.observe(phoneFleetOverviewViewport);
  } else {
    window.addEventListener("resize", scheduleFleetOverviewRender);
  }
  setInterval(() => {
    if (!latestWorkzoneVisual) return;
    renderWorkzoneVisual();
  }, 1000);
  permissionRefreshModalAction?.addEventListener("click", (event) => {
    event.stopPropagation();
    void handlePermissionRefreshAction();
  });
  permissionRefreshModalRefresh?.addEventListener("click", (event) => {
    event.stopPropagation();
    window.location.reload();
  });
  permissionRefreshModalDismiss?.addEventListener("click", (event) => {
    event.stopPropagation();
    clearPermissionRefreshNotice();
  });
  document.addEventListener("pointerdown", () => {
    void primeAlertAudioWithOptions({ interactive: true });
    try { window.speechSynthesis?.getVoices?.(); } catch {}
  }, { passive: true });
  document.addEventListener("click", (event) => {
    void unlockVoiceAlertsFromGesture();
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest?.(".phone-alert-btn")) return;
    void replayPendingAlertIfPossible();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    void unlockVoiceAlertsFromGesture();
    if (!pendingAlertReplay) return;
    void replayPendingAlertIfPossible();
  });
  document.addEventListener("fullscreenchange", handleCarViewFullscreenChange);
  document.addEventListener("webkitfullscreenchange", handleCarViewFullscreenChange);
  window.addEventListener("resize", () => {
    if (carViewActive) renderCarViewHud();
  });

  cameraFlipBtn?.addEventListener("click", async () => {
    cameraFacingMode = cameraFacingMode === "environment" ? "user" : "environment";
    if (runConfig.streams.camera.mode !== "off" && started) {
      await restartCamera();
      renderStatus();
    }
  });
  deviceNameInput?.addEventListener("input", () => {
    renderJoinValidation();
    renderDeviceIdentity();
    renderPrimaryAction();
  });
  joinCodeInput?.addEventListener("input", () => {
    joinCodeTouched = true;
    const normalized = normalizeJoinCode(joinCodeInput.value).slice(0, 6);
    if (joinCodeInput.value !== normalized) joinCodeInput.value = normalized;
    renderJoinValidation();
    renderPrimaryAction();
  });

  disconnectBtn?.addEventListener("click", () => {
    if (!wsClient || !started) return;
    if (wsClient.isConnected()) {
      wsClient.disconnect(true);
      setConnectionUi(false, "Disconnected");
      setJoinStatus("Disconnected");
      renderStatus();
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
    const voiceUnlock = unlockVoiceAlertsFromGesture({ force: true });
    await primeAlertAudio();
    await voiceUnlock;
    started = true;
    startBtn.disabled = true;
    updateJoinFieldLock();
    setJoinStatus("Authorizing...");
    renderStatus();
    try {
      authState = await authorizePhoneJoin({ deviceName, joinCode, deviceId: runConfig.device_id });
      runConfig.device_id = authState.deviceId;
      persistReconnectKey(authState.reconnectKey || reconnectKey);
      renderDeviceIdentity();
      setJoinStatus(`Authorized for session ${joinCode} as ${authState.deviceName}`);
      persistJoinFields(deviceName, joinCode);
      await requestPermissionsAndStart();
      connectWs();
      await applyConfig();
    } catch (err) {
      started = false;
      updateJoinFieldLock();
      setJoinStatus(String(err?.message || "Authorization failed"), true);
      renderStatus();
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
        setJoinStatus(`Connected to session ${normalizeJoinCode(joinCodeInput?.value)} as ${authState.deviceName}`);
        renderStatus();
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
        closeAllPreviewPeers("signaling_lost");
        lastPreviewStatusSent = "";
        setConnectionUi(false, "Disconnected");
        if (started) setJoinStatus("Disconnected - retrying");
        renderStatus();
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
          renderDeviceIdentity();
          emitPreviewStatus(true);
          renderStatus();
          return;
        }
        if (msg.type === "auth_required") {
          started = false;
          authState = null;
          sessionRecordingActive = false;
          hasSeenRecordingState = false;
          recentFleetAlertIds.clear();
          resetWorkzoneAnnouncementTracking({ clearRecent: true });
          updateJoinFieldLock();
          renderStatus();
          setJoinStatus("Join token expired - tap Start again");
          wsClient?.disconnect(true);
          return;
        }
        if (msg.type === "config") {
          if (msg.device_id && msg.device_id !== runConfig.device_id) return;
          runConfig = mergeRunConfig(msg.runConfig);
          renderStatus();
          void applyConfig();
          return;
        }
        if (msg.type === "recording_state") {
          const wasRecording = sessionRecordingActive;
          const nextRecording = !!msg.active;
          const shouldPlayRecordingCue = hasSeenRecordingState && nextRecording !== wasRecording;
          sessionRecordingActive = nextRecording;
          hasSeenRecordingState = true;
          if (sessionRecordingActive && !wasRecording) {
            cameraVideoRecorderFallback = false;
          }
          if (!sessionRecordingActive) {
            flushPcmChunk(audioCtx?.sampleRate || 48000);
            recentFleetAlertIds.clear();
            resetWorkzoneAnnouncementTracking({ clearRecent: true });
          }
          updateCameraTransport();
          void ensureAudioRunning();
          renderStatus();
          if (shouldPlayRecordingCue) void playRecordingStateCue({ active: sessionRecordingActive });
          return;
        }
        if (msg.type === "force_disconnect") {
          handleForcedDisconnect(msg);
          return;
        }
        if (msg.type === "fleet_alert") {
          void handleFleetAlert(msg);
          return;
        }
        if (msg.type === "fleet_overview") {
          fleetOverview = normalizeFleetOverviewPayload(msg);
          syncWorkzoneAnnouncementsFromFleetOverview();
          reconcileLatestWorkzoneVisualFromFleetOverview();
          renderWorkzoneVisual();
          scheduleFleetOverviewRender();
          return;
        }
        if (msg.type === "webrtc_signal") {
          void handlePreviewSignal(msg);
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
      closeAllPreviewPeers("camera_off", true);
      cameraPermissionState = runConfig.streams.camera.record || runConfig.streams.camera.mode !== "off" ? cameraPermissionState : "idle";
    } else {
      await ensureCameraStream();
      syncPreviewTracks();
      updateCameraTransport();
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
      if (joinStatus?.textContent === "Motion pending") {
        setJoinStatus(`Connected to session ${normalizeJoinCode(joinCodeInput?.value)} as ${authState?.deviceName || detectDeviceType()}`);
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
    let capturing = false;
    frameTimer = setInterval(async () => {
      if (capturing) return;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (runConfig.streams.camera.mode !== "stream") return;
      const w = previewEl.videoWidth;
      const h = previewEl.videoHeight;
      if (!w || !h) return;
      capturing = true;
      try {
        const down = Math.max(1, Number(runConfig.streams.camera.downsample_factor || 1));
        const targetW = Math.max(1, Math.floor(w / down));
        const targetH = Math.max(1, Math.floor(h / down));
        if (canvas.width !== targetW || canvas.height !== targetH) {
          canvas.width = targetW;
          canvas.height = targetH;
        }
        ctx2d.drawImage(previewEl, 0, 0, targetW, targetH);
        const lightingScore = estimateLighting(ctx2d, targetW, targetH);
        const q = Math.max(0.1, Math.min(0.95, Number(runConfig.streams.camera.jpeg_q || 0.6)));
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", q));
        if (!blob) return;
        const buffer = await blob.arrayBuffer();
        if (!sendBinaryMessage({
          type: "camera_header",
          device_id: runConfig.device_id,
          t_device_ms: getDeviceMonoMs(),
          frame_id: "phone_camera",
          format: "jpeg",
          lighting_score: lightingScore,
          record_for_session: shouldRecordCameraSnapshotsForSession()
        }, buffer)) return;
        lastCameraFrameMs = Date.now();
      } finally {
        capturing = false;
      }
    }, Math.max(16, Math.floor(1000 / getSnapshotLoopFps())));
  }

  function stopFrameLoop() {
    if (!frameTimer) return;
    clearInterval(frameTimer);
    frameTimer = null;
  }

  function getPreviewCameraFps() {
    return Math.max(1, Number(runConfig.streams.camera?.fps || 10));
  }

  function getRecordingCameraFps() {
    return Math.max(getPreviewCameraFps(), Number(runConfig.streams.camera?.video_fps || runConfig.streams.camera?.fps || 10));
  }

  function getCameraRecordMode() {
    const mode = String(runConfig.streams.camera?.record_mode || "both").toLowerCase();
    if (mode === "jpg" || mode === "video" || mode === "both") return mode;
    return "both";
  }

  function canDirectRecordCameraVideo() {
    return typeof MediaRecorder === "function";
  }

  function shouldUseDirectCameraRecorder() {
    return started &&
      !!cameraStream &&
      runConfig.streams.camera.mode === "stream" &&
      sessionRecordingActive &&
      !!runConfig.streams.camera?.record &&
      getCameraRecordMode() !== "jpg" &&
      canDirectRecordCameraVideo() &&
      !cameraVideoRecorderFallback;
  }

  function shouldRecordCameraSnapshotsForSession() {
    if (!(sessionRecordingActive && runConfig.streams.camera?.record)) return false;
    const recordMode = getCameraRecordMode();
    if (recordMode === "jpg" || recordMode === "both") return true;
    return !canDirectRecordCameraVideo() || cameraVideoRecorderFallback;
  }

  function getSnapshotLoopFps() {
    return shouldRecordCameraSnapshotsForSession()
      ? getRecordingCameraFps()
      : getPreviewCameraFps();
  }

  function isDirectCameraRecorderActive() {
    return !!cameraVideoRecorder && cameraVideoRecorder.state !== "inactive";
  }

  function shouldRunSnapshotLoop() {
    const mode = runConfig.streams.camera.mode === "preview" ? "stream" : runConfig.streams.camera.mode;
    return started &&
      mode === "stream" &&
      (connectedPreviewPeerCount() === 0 || shouldRecordCameraSnapshotsForSession());
  }

  function updateCameraTransport() {
    if (!cameraStream || !shouldRunSnapshotLoop()) {
      stopFrameLoop();
    } else {
      startFrameLoop();
    }
    void syncDirectCameraRecorder();
  }

  function stopCamera() {
    stopFrameLoop();
    if (!cameraStream) {
      void syncDirectCameraRecorder();
      return;
    }
    for (const t of cameraStream.getTracks()) t.stop();
    cameraStream = null;
    previewEl.srcObject = null;
    cameraVideoRecorderFallback = false;
    void syncDirectCameraRecorder();
    emitPreviewStatus(true);
  }

  async function restartCamera() {
    stopFrameLoop();
    cameraVideoRecorderFallback = false;
    if (cameraStream) {
      for (const t of cameraStream.getTracks()) t.stop();
    }
    cameraStream = null;
    previewEl.srcObject = null;
    if (runConfig.streams.camera.mode === "off") return;
    await ensureCameraStream();
    syncPreviewTracks();
    updateCameraTransport();
    emitPreviewStatus(true);
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
      syncPhoneAudioSession();
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
    syncPhoneAudioSession();
    await resumeAudioContext();
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
        noise_level: Number(Math.sqrt(sum / arr.length).toFixed(4)),
        pcm_age_ms: lastPcmChunkMs ? Date.now() - lastPcmChunkMs : null,
        audio_context_state: audioCtx?.state || "unknown"
      });
      lastAudioEventMs = Date.now();
      void ensureAudioRunning();
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
    lastPcmChunkMs = Date.now();
    pcmChunkParts = [];
    pcmChunkSamples = 0;
  }

  async function ensureAudioRunning() {
    if (!started || !runConfig.streams.audio?.enabled || !audioCtx) return;
    await resumeAudioContext();
    if (!sessionRecordingActive || pcmRestarting) return;
    const now = Date.now();
    if (lastPcmChunkMs && now - lastPcmChunkMs < 6000) return;
    if (!lastPcmChunkMs && lastAudioEventMs && now - lastAudioEventMs < 6000) return;
    await restartPcmCapture();
  }

  async function resumeAudioContext() {
    try {
      if (audioCtx && audioCtx.state === "suspended") await audioCtx.resume();
    } catch {}
    try {
      if (silentAudio?.ctx?.state === "suspended") await silentAudio.ctx.resume();
    } catch {}
    try {
      if (alertAudioCtx && alertAudioCtx.state === "suspended") await alertAudioCtx.resume();
    } catch {}
    if (!wakeLock) await requestWakeLock();
  }

  function alertCooldownRemainingMs(kind = "generic") {
    const lastSentAtMs = kind === "workzone" ? lastWorkzoneAlertSentAtMs : lastGenericAlertSentAtMs;
    return Math.max(0, 1500 - (Date.now() - lastSentAtMs));
  }

  function isAlertCoolingDown(kind = "generic") {
    return alertCooldownRemainingMs(kind) > 0;
  }

  function scheduleAlertCooldownRefresh() {
    if (alertCooldownTimer) clearTimeout(alertCooldownTimer);
    const nextDelay = Math.max(
      alertCooldownRemainingMs("generic"),
      alertCooldownRemainingMs("workzone")
    );
    if (nextDelay <= 0) return;
    alertCooldownTimer = setTimeout(() => {
      alertCooldownTimer = null;
      renderPrimaryAction();
    }, nextDelay + 20);
  }

  function setAlertFeedback(text, tone = "muted", ttlMs = 2600) {
    alertFeedbackText = String(text || "").trim();
    alertFeedbackTone = tone || "muted";
    if (alertFeedbackTimer) clearTimeout(alertFeedbackTimer);
    if (!alertFeedbackText || ttlMs <= 0) {
      renderPrimaryAction();
      return;
    }
    alertFeedbackTimer = setTimeout(() => {
      alertFeedbackTimer = null;
      alertFeedbackText = "";
      alertFeedbackTone = "muted";
      renderPrimaryAction();
    }, ttlMs);
    renderPrimaryAction();
  }

  function setDocumentAudioSessionType(type) {
    const nextType = String(type || "").trim();
    if (!nextType) return false;
    try {
      if (!navigator.audioSession || navigator.audioSession.type === nextType) return false;
      navigator.audioSession.type = nextType;
      return true;
    } catch {}
    return false;
  }

  function syncPhoneAudioSession({ preferAlertPlayback = false } = {}) {
    const micActive = !!(runConfig.streams.audio?.enabled && (micStream || audioCtx));
    const desiredType = (micActive && !preferAlertPlayback) ? "play-and-record" : "playback";
    setDocumentAudioSessionType(desiredType);
  }

  async function primeAlertAudio(options = {}) {
    return primeAlertAudioWithOptions(options);
  }

  function ensureAlertAudioGraph() {
    if (!alertAudioCtx) return false;
    try {
      if (!alertAudioCompressor) {
        alertAudioCompressor = alertAudioCtx.createDynamicsCompressor();
        alertAudioCompressor.threshold.value = -24;
        alertAudioCompressor.knee.value = 18;
        alertAudioCompressor.ratio.value = 10;
        alertAudioCompressor.attack.value = 0.003;
        alertAudioCompressor.release.value = 0.18;
      }
      if (!alertAudioMasterGain) {
        alertAudioMasterGain = alertAudioCtx.createGain();
        alertAudioMasterGain.gain.value = 0.58;
      }
      if (!alertAudioGraphReady) {
        alertAudioMasterGain.connect(alertAudioCompressor);
        alertAudioCompressor.connect(alertAudioCtx.destination);
        alertAudioGraphReady = true;
      }
      return true;
    } catch {}
    return false;
  }

  function warmAlertAudioOutput() {
    if (!alertAudioCtx || !alertAudioMasterGain) return;
    try {
      if (alertAudioWarmup) {
        try { alertAudioWarmup.osc.stop(); } catch {}
        try { alertAudioWarmup.osc.disconnect(); } catch {}
        try { alertAudioWarmup.gain.disconnect(); } catch {}
        alertAudioWarmup = null;
      }
      const osc = alertAudioCtx.createOscillator();
      const gain = alertAudioCtx.createGain();
      const now = alertAudioCtx.currentTime;
      gain.gain.setValueAtTime(0.00001, now);
      osc.frequency.setValueAtTime(140, now);
      osc.connect(gain);
      gain.connect(alertAudioMasterGain);
      osc.start(now);
      osc.stop(now + 0.05);
      osc.onended = () => {
        try { osc.disconnect(); } catch {}
        try { gain.disconnect(); } catch {}
        if (alertAudioWarmup?.osc === osc) alertAudioWarmup = null;
      };
      alertAudioWarmup = { osc, gain };
    } catch {}
  }

  function getIosSpeakerPrimerEl() {
    if (!iosSpeakerPrimerEl) {
      // Minimal valid silent WAV (44 bytes). Playing any <audio> element from a
      // user gesture tells iOS to switch AVAudioSession to media playback (speaker),
      // which the AudioContext then inherits — critical when camera is active.
      const wav = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
      iosSpeakerPrimerEl = new Audio(wav);
      iosSpeakerPrimerEl.volume = 0.001;
    }
    return iosSpeakerPrimerEl;
  }

  function createSilentWavObjectUrl({ seconds = 1, sampleRate = 8000 } = {}) {
    const samples = Math.max(1, Math.round(Number(seconds || 1) * Number(sampleRate || 8000)));
    const dataSize = samples * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const writeAscii = (offset, text) => {
      for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
    };
    writeAscii(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeAscii(8, "WAVE");
    writeAscii(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(36, "data");
    view.setUint32(40, dataSize, true);
    return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
  }

  async function ensureAlertMediaPlaybackAnchor({ interactive = false } = {}) {
    try {
      if (!alertMediaAnchorEl) {
        alertMediaAnchorUrl = createSilentWavObjectUrl();
        alertMediaAnchorEl = new Audio(alertMediaAnchorUrl);
        alertMediaAnchorEl.loop = true;
        alertMediaAnchorEl.volume = 0.001;
        alertMediaAnchorEl.preload = "auto";
        alertMediaAnchorEl.setAttribute("playsinline", "true");
      }
      syncPhoneAudioSession({ preferAlertPlayback: true });
      if (navigator.mediaSession) {
        try {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: "D3C Safety Alerts",
            artist: "D3C",
            album: "Live Session"
          });
          navigator.mediaSession.playbackState = "playing";
        } catch {}
      }
      if (interactive || alertMediaAnchorEl.paused) {
        try { alertMediaAnchorEl.currentTime = 0; } catch {}
        await alertMediaAnchorEl.play();
      }
      return !alertMediaAnchorEl.paused;
    } catch {
      return false;
    }
  }

  async function primeAlertAudioWithOptions({ interactive = false } = {}) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    syncPhoneAudioSession({ preferAlertPlayback: true });
    try {
      await ensureAlertMediaPlaybackAnchor({ interactive });
      // iOS suspends AudioContexts when getUserMedia(video) starts and routes them
      // through the camera's audio session (earpiece). Close and recreate so the
      // new context is initialized with the "playback" session we just set.
      if (cameraStream && alertAudioCtx && alertAudioCtx.state === "suspended") {
        try { await alertAudioCtx.close(); } catch {}
        alertAudioCtx = null;
        alertAudioMasterGain = null;
        alertAudioCompressor = null;
        alertAudioGraphReady = false;
        alertAudioWarmup = null;
      }
      if (!alertAudioCtx || alertAudioCtx.state === "closed") {
        alertAudioCtx = new Ctx();
        alertAudioMasterGain = null;
        alertAudioCompressor = null;
        alertAudioGraphReady = false;
        alertAudioWarmup = null;
      }
      if (alertAudioCtx.state === "suspended") {
        await alertAudioCtx.resume();
      }
      // Playing a silent <audio> element on interactive calls further nudges iOS
      // to route audio output to the speaker regardless of camera state.
      if (interactive) {
        try {
          const primer = getIosSpeakerPrimerEl();
          primer.currentTime = 0;
          await primer.play();
        } catch {}
      }
      if (!ensureAlertAudioGraph()) return false;
      if (interactive) warmAlertAudioOutput();
    } catch {}
    return !!alertAudioCtx && alertAudioCtx.state === "running";
  }

  function playAlertHaptics() {
    try {
      if (typeof navigator?.vibrate === "function") {
        return navigator.vibrate([150, 90, 150, 120, 260]);
      }
    } catch {}
    return false;
  }

  function queuePendingAlertReplay(sourceDeviceName, kind = "", announcementText = "") {
    pendingAlertReplay = {
      sourceDeviceName: String(sourceDeviceName || "another phone").trim() || "another phone",
      kind: String(kind || "").trim(),
      announcementText: String(announcementText || "").trim(),
      queuedAtMs: Date.now(),
      expiresAtMs: Date.now() + 60000,
      attempts: 0
    };
    schedulePendingAlertReplay();
  }

  function isWorkzoneReplayKind(kind = "") {
    return String(kind || "").trim().startsWith("workzone_");
  }

  function pruneRecentFleetAlertIds(now = Date.now()) {
    for (const [alertId, ts] of recentFleetAlertIds.entries()) {
      if ((now - Number(ts || 0)) > 60000) recentFleetAlertIds.delete(alertId);
    }
  }

  function acknowledgeFleetAlert(alertId = "") {
    const cleanAlertId = String(alertId || "").trim();
    if (!cleanAlertId || !ws || ws.readyState !== WebSocket.OPEN) return;
    queueJson({
      type: "fleet_alert_received",
      alert_id: cleanAlertId,
      device_id: runConfig.device_id,
      t_device_ms: getDeviceMonoMs()
    });
  }

  function rememberFleetAlert(alertId = "") {
    const cleanAlertId = String(alertId || "").trim();
    if (!cleanAlertId) return true;
    const now = Date.now();
    pruneRecentFleetAlertIds(now);
    const isFirstDelivery = !recentFleetAlertIds.has(cleanAlertId);
    recentFleetAlertIds.set(cleanAlertId, now);
    return isFirstDelivery;
  }

  function clearPendingAlertReplaySchedule() {
    if (!pendingAlertReplayTimer) return;
    clearTimeout(pendingAlertReplayTimer);
    pendingAlertReplayTimer = null;
  }

  function schedulePendingAlertReplay() {
    clearPendingAlertReplaySchedule();
    if (!pendingAlertReplay) return;
    pendingAlertReplayTimer = setTimeout(() => {
      pendingAlertReplayTimer = null;
      void replayPendingAlertIfPossible();
    }, 1400);
  }

  function gpsDistanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180, Δλ = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function gpsBearingDeg(lat1, lon1, lat2, lon2) {
    const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function workzoneRelativeDirection(bearingDeg, headingDeg) {
    if (!Number.isFinite(headingDeg) || headingDeg < 0) {
      const cardinals = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
      return "to your " + cardinals[Math.round(bearingDeg / 45) % 8];
    }
    const rel = ((bearingDeg - headingDeg) % 360 + 360) % 360;
    if (rel < 22.5 || rel >= 337.5) return "ahead";
    if (rel < 67.5) return "ahead and to your right";
    if (rel < 112.5) return "to your right";
    if (rel < 157.5) return "behind and to your right";
    if (rel < 202.5) return "behind you";
    if (rel < 247.5) return "behind and to your left";
    if (rel < 292.5) return "to your left";
    return "ahead and to your left";
  }

  function buildWorkzoneDirectionPhrase(sourceGps) {
    if (!sourceGps || !latestOwnGps) return null;
    const now = Date.now();
    if ((now - Number(sourceGps.t_recv_ms || 0)) > 30000) return null;
    if ((now - Number(latestOwnGps.t_ms || 0)) > 30000) return null;
    const srcLat = Number(sourceGps.lat), srcLon = Number(sourceGps.lon);
    const ownLat = Number(latestOwnGps.lat), ownLon = Number(latestOwnGps.lon);
    if (!Number.isFinite(srcLat) || !Number.isFinite(srcLon) || Math.abs(srcLat) > 90 || Math.abs(srcLon) > 180) return null;
    if (Math.abs(srcLat) < 0.0001 && Math.abs(srcLon) < 0.0001) return null;
    const dist = gpsDistanceMeters(ownLat, ownLon, srcLat, srcLon);
    const bearing = gpsBearingDeg(ownLat, ownLon, srcLat, srcLon);
    const heading = Number(latestOwnGps.heading_deg ?? -1);
    const feet = dist * 3.281;
    if (feet < 200) return "just ahead of you";
    const dir = workzoneRelativeDirection(bearing, heading);
    if (feet < 1500) {
      const rounded = Math.round(feet / 50) * 50;
      return `about ${rounded} feet ${dir}`;
    }
    const miles = dist / 1609.34;
    let distLabel;
    if (miles < 0.35) distLabel = "about a quarter mile";
    else if (miles < 0.65) distLabel = "about half a mile";
    else if (miles < 0.9) distLabel = "less than a mile";
    else if (miles < 1.3) distLabel = "about a mile";
    else distLabel = `about ${miles.toFixed(1)} miles`;
    return `${distLabel} ${dir}`;
  }

  function buildWorkzoneAnnouncementText(sourceDeviceName = "", { sourceGps = null, isSelf = false } = {}) {
    const cleanName = String(sourceDeviceName || "").trim();
    if (isSelf) return "Workzone detected.";
    if (!isSelf) {
      const direction = buildWorkzoneDirectionPhrase(sourceGps);
      if (direction && cleanName) return `Workzone is ${direction}, detected by ${cleanName}.`;
      if (direction) return `Workzone is ${direction}.`;
    }
    if (!cleanName) return "Workzone detected";
    return `Workzone detected by ${cleanName}`;
  }

  function buildWorkzoneDetectedMessage(sourceDeviceName = "", { detectionCount = 0, classSummary = "", isSelf = false } = {}) {
    const cleanName = String(sourceDeviceName || "").trim() || "another phone";
    const totalDetections = Math.max(0, Number(detectionCount || 0));
    const summary = String(classSummary || "").trim();
    if (isSelf) {
      if (summary && totalDetections > 0) {
        return `Workzone detected with ${totalDetections} detection${totalDetections === 1 ? "" : "s"} (${summary}).`;
      }
      if (totalDetections > 0) {
        return `Workzone detected with ${totalDetections} detection${totalDetections === 1 ? "" : "s"}.`;
      }
      if (summary) return `Workzone detected (${summary}).`;
      return "Workzone detected.";
    }
    if (summary && totalDetections > 0) {
      return `Workzone detected by ${cleanName} with ${totalDetections} detection${totalDetections === 1 ? "" : "s"} (${summary}).`;
    }
    if (totalDetections > 0) {
      return `Workzone detected by ${cleanName} with ${totalDetections} detection${totalDetections === 1 ? "" : "s"}.`;
    }
    if (summary) {
      return `Workzone detected by ${cleanName} (${summary}).`;
    }
    return `Workzone detected by ${cleanName}.`;
  }

  function buildWorkzoneExitedAnnouncementText(sourceDeviceName = "", { isSelf = false } = {}) {
    const cleanName = String(sourceDeviceName || "").trim();
    if (isSelf || !cleanName) return "Exited workzone.";
    return `Exited workzone, reported by ${cleanName}.`;
  }

  function buildWorkzoneExitedMessage(sourceDeviceName = "", { isSelf = false } = {}) {
    const cleanName = String(sourceDeviceName || "").trim();
    if (isSelf || !cleanName) return "Exited workzone.";
    return `Exited workzone reported by ${cleanName}.`;
  }

  function pruneRecentWorkzoneAnnouncementKeys(now = Date.now()) {
    for (const [key, ts] of recentWorkzoneAnnouncementKeys.entries()) {
      if ((now - Number(ts || 0)) > 20000) recentWorkzoneAnnouncementKeys.delete(key);
    }
  }

  function resetWorkzoneAnnouncementTracking({ clearRecent = false } = {}) {
    workzoneOverviewStateByDevice.clear();
    workzoneOverviewBaselineReady = false;
    if (clearRecent) recentWorkzoneAnnouncementKeys.clear();
  }

  function buildWorkzoneAnnouncementEvent({
    sourceDeviceId = "",
    sourceDeviceName = "",
    updatedAtMs = 0,
    detectionCount = 0,
    score = 0,
    classSummary = "",
    sourceGps = null
  } = {}) {
    const cleanDeviceId = String(sourceDeviceId || "").trim();
    const cleanDeviceName = String(sourceDeviceName || cleanDeviceId || "another phone").trim() || "another phone";
    const cleanUpdatedAtMs = Number.isFinite(Number(updatedAtMs)) && Number(updatedAtMs) > 0 ? Number(updatedAtMs) : 0;
    const cleanDetectionCount = Math.max(0, Number(detectionCount || 0));
    const cleanScore = Number.isFinite(Number(score)) ? Number(score) : 0;
    const isSelf = !!cleanDeviceId && cleanDeviceId === runConfig.device_id;
    return {
      sourceDeviceId: cleanDeviceId,
      sourceDeviceName: cleanDeviceName,
      updatedAtMs: cleanUpdatedAtMs,
      detectionCount: cleanDetectionCount,
      score: cleanScore,
      classSummary: String(classSummary || "").trim(),
      sourceGps: sourceGps || null,
      isSelf,
      announcementText: buildWorkzoneAnnouncementText(cleanDeviceName, { sourceGps, isSelf }),
      key: [cleanDeviceId || cleanDeviceName, cleanUpdatedAtMs || 0, cleanDetectionCount, cleanScore.toFixed(3)].join("|")
    };
  }

  async function playDedupedWorkzoneAnnouncement(eventInput = {}) {
    const event = buildWorkzoneAnnouncementEvent(eventInput);
    const now = Date.now();
    pruneRecentWorkzoneAnnouncementKeys(now);
    if (event.key && recentWorkzoneAnnouncementKeys.has(event.key)) {
      return { played: true, mode: "deduped", deduped: true, event, announcementText: event.announcementText };
    }
    if (
      pendingAlertReplay
      && isWorkzoneReplayKind(pendingAlertReplay.kind)
      && pendingAlertReplay.announcementText === event.announcementText
    ) {
      return { played: true, mode: "pending", deduped: true, event, announcementText: event.announcementText };
    }
    const result = await playWorkzoneAnnouncement({ announcementText: event.announcementText });
    if (result.played && event.key) recentWorkzoneAnnouncementKeys.set(event.key, now);
    return { ...result, deduped: false, event, announcementText: event.announcementText };
  }

  async function handleWorkzoneOverviewDetection(device) {
    const devGps = device?.gps_latest;
    const event = buildWorkzoneAnnouncementEvent({
      sourceDeviceId: device?.device_id,
      sourceDeviceName: device?.device_name || device?.device_id,
      updatedAtMs: Number(device?.workzone_updated_at_ms || fleetOverview?.generated_at_ms || Date.now()),
      detectionCount: Number(device?.workzone_detection_count || 0),
      score: Number(device?.workzone_score),
      classSummary: String(device?.workzone_class_summary || "").trim(),
      sourceGps: (devGps && Number.isFinite(Number(devGps.lat)) && Number.isFinite(Number(devGps.lon)))
        ? { lat: Number(devGps.lat), lon: Number(devGps.lon), t_recv_ms: Number(devGps.t_recv_ms || 0) }
        : null
    });
    const result = await playDedupedWorkzoneAnnouncement(event);
    if (result.deduped) return;
    const message = buildWorkzoneDetectedMessage(event.sourceDeviceName, {
      detectionCount: event.detectionCount,
      classSummary: event.classSummary,
      isSelf: event.isSelf
    });
    if (result.played) {
      setAlertFeedback(message, "warning", 5000);
      return;
    }
    queuePendingAlertReplay(event.sourceDeviceName, "workzone_detected", event.announcementText);
    setAlertFeedback(`${message} If Safari blocked speech, tap once anywhere on this phone and it will keep retrying the exact phrase.`, "warning", 5600);
  }

  async function handleWorkzoneOverviewExit(device) {
    const deviceId = String(device?.device_id || "").trim();
    const sourceDeviceName = String(device?.device_name || deviceId || "another phone").trim() || "another phone";
    const isSelf = !!deviceId && deviceId === runConfig.device_id;
    const updatedAtMs = Number(device?.workzone_updated_at_ms || fleetOverview?.generated_at_ms || Date.now());
    const announcementText = buildWorkzoneExitedAnnouncementText(sourceDeviceName, { isSelf });
    const key = ["exit", deviceId || sourceDeviceName, updatedAtMs || 0].join("|");
    const now = Date.now();
    pruneRecentWorkzoneAnnouncementKeys(now);
    if (recentWorkzoneAnnouncementKeys.has(key)) return;
    const result = await playWorkzoneAnnouncement({ announcementText, allowLockedTone: true });
    if (result.played) {
      recentWorkzoneAnnouncementKeys.set(key, now);
      setAlertFeedback(buildWorkzoneExitedMessage(sourceDeviceName, { isSelf }), "success", 4200);
      return;
    }
    queuePendingAlertReplay(sourceDeviceName, "workzone_exited", announcementText);
    setAlertFeedback(`${buildWorkzoneExitedMessage(sourceDeviceName, { isSelf })} If Safari blocked speech, tap once anywhere on this phone and it will retry the exact phrase.`, "warning", 5600);
  }

  function syncWorkzoneAnnouncementsFromFleetOverview() {
    const devices = Array.isArray(fleetOverview?.devices) ? fleetOverview.devices : [];
    const now = Date.now();
    if (!workzoneAlertsEnabled) {
      for (const device of devices) {
        const deviceId = String(device?.device_id || "").trim();
        if (!deviceId) continue;
        const machineState = normalizeCarViewMachineState(device?.workzone_fused_state, device?.workzone_found ? "detected" : "");
        workzoneOverviewStateByDevice.set(deviceId, {
          detected: !!device?.workzone_found,
          active: !!device?.workzone_active,
          tracking: !!device?.workzone_tracking,
          machineState,
          updatedAtMs: Number(device?.workzone_updated_at_ms || 0),
          exitAnnouncedAtMs: Number(workzoneOverviewStateByDevice.get(deviceId)?.exitAnnouncedAtMs || 0)
        });
      }
      workzoneOverviewBaselineReady = true;
      return;
    }
    const seen = new Set();
    for (const device of devices) {
      const deviceId = String(device?.device_id || "").trim();
      if (!deviceId) continue;
      seen.add(deviceId);
      const nextDetected = !!device?.workzone_found;
      const nextActive = !!device?.workzone_active;
      const nextTracking = !!device?.workzone_tracking;
      const nextMachineState = normalizeCarViewMachineState(device?.workzone_fused_state, nextDetected ? "detected" : (nextTracking ? "tracking" : ""));
      const nextUpdatedAtMs = Number(device?.workzone_updated_at_ms || 0);
      const prev = workzoneOverviewStateByDevice.get(deviceId) || null;
      const hasFreshTimestamp = nextUpdatedAtMs > 0 && Math.abs(now - nextUpdatedAtMs) <= 12000;
      const prevMachineState = normalizeCarViewMachineState(prev?.machineState, prev?.detected ? "detected" : "");
      const prevWasInWorkzone = workzoneMachineStateRank(prevMachineState) > 0;
      const nextIsOut = nextMachineState === "OUT" && !nextDetected;
      const exitCooldownReady = !prev?.exitAnnouncedAtMs || (now - Number(prev.exitAnnouncedAtMs || 0)) > 15000;
      const shouldAnnounce = nextDetected && (
        (!workzoneOverviewBaselineReady && deviceId === runConfig.device_id && hasFreshTimestamp)
        || (workzoneOverviewBaselineReady && !prev?.detected && (hasFreshTimestamp || nextUpdatedAtMs <= 0))
      );
      const shouldAnnounceExit = workzoneOverviewBaselineReady
        && deviceId === runConfig.device_id
        && prevWasInWorkzone
        && nextIsOut
        && hasFreshTimestamp
        && exitCooldownReady;
      workzoneOverviewStateByDevice.set(deviceId, {
        detected: nextDetected,
        active: nextActive,
        tracking: nextTracking,
        machineState: nextMachineState,
        updatedAtMs: nextUpdatedAtMs,
        exitAnnouncedAtMs: shouldAnnounceExit ? now : Number(prev?.exitAnnouncedAtMs || 0)
      });
      if (shouldAnnounce) void handleWorkzoneOverviewDetection(device);
      if (shouldAnnounceExit) void handleWorkzoneOverviewExit(device);
    }
    for (const deviceId of [...workzoneOverviewStateByDevice.keys()]) {
      if (!seen.has(deviceId)) workzoneOverviewStateByDevice.delete(deviceId);
    }
    workzoneOverviewBaselineReady = true;
  }

  function summarizeWorkzoneClassCounts(classCounts) {
    return Object.entries(classCounts || {})
      .filter(([, count]) => Number(count) > 0)
      .sort((a, b) => Number(b[1]) - Number(a[1]) || String(a[0]).localeCompare(String(b[0])))
      .slice(0, 3)
      .map(([label, count]) => `${String(label)} x${Number(count)}`)
      .join(" • ");
  }

  function formatRelativeAgeMs(value) {
    const ms = Number(value);
    if (!Number.isFinite(ms) || ms < 0) return "";
    if (ms < 1000) return `${Math.round(ms)} ms ago`;
    const sec = ms / 1000;
    if (sec < 10) return `${sec.toFixed(1)} s ago`;
    if (sec < 60) return `${Math.round(sec)} s ago`;
    const min = sec / 60;
    if (min < 10) return `${min.toFixed(1)} m ago`;
    return `${Math.round(min)} m ago`;
  }

  function formatLatencyMs(value, { approximate = false } = {}) {
    const ms = Number(value);
    if (!Number.isFinite(ms) || ms < 0) return "";
    const prefix = approximate ? "~" : "";
    if (ms < 1000) return `${prefix}${Math.round(ms)} ms`;
    const sec = ms / 1000;
    if (sec < 10) return `${prefix}${sec.toFixed(2)} s`;
    return `${prefix}${sec.toFixed(1)} s`;
  }

  function workzoneMachineStateRank(value) {
    const state = normalizeCarViewMachineState(value);
    if (state === "INSIDE") return 4;
    if (state === "APPROACHING") return 3;
    if (state === "EXITING") return 2;
    return 0;
  }

  function updateLatestWorkzoneVisual(msg, { fromSelf = false } = {}) {
    const workzone = msg?.workzone && typeof msg.workzone === "object" ? msg.workzone : {};
    const latency = workzone?.latency && typeof workzone.latency === "object" ? workzone.latency : {};
    const classSummary = summarizeWorkzoneClassCounts(workzone.class_counts || {});
    const receivedAtMs = Date.now();
    const sourceName = String(msg?.source_device_name || msg?.source_device_id || "another phone").trim() || "another phone";
    latestWorkzoneVisual = {
      title: String(msg?.title || "Workzone detected").trim() || "Workzone detected",
      message: fromSelf
        ? "Workzone detected."
        : (String(msg?.message || "").trim() || `Workzone detected by ${sourceName}.`),
      state: "detected",
      fusedState: String(workzone.state || workzone.fused_state || "INSIDE").trim().toUpperCase() || "INSIDE",
      sourceDeviceName: sourceName,
      fromSelf: !!fromSelf,
      score: Number(workzone.score),
      scoreThreshold: Number(workzone.score_threshold),
      maxConfidence: Number(workzone.max_confidence),
      detectionCount: Math.max(0, Number(workzone.detection_count || 0)),
      classSummary,
      frameToAlertMs: Number(latency.frame_to_alert_ms),
      frameToResultMs: Number(latency.frame_to_result_ms),
      queueWaitMs: Number(latency.queue_wait_ms),
      dispatchToResultMs: Number(latency.dispatch_to_result_ms),
      resultToAlertMs: Number(latency.result_to_alert_ms),
      inferenceMs: Number(latency.inference_ms ?? workzone.inference_ms),
      sourceRttMs: Number(latency.source_rtt_ms),
      approxPhoneReceiveMs: Number(msg?.t_server_ms) > 0 ? Math.max(0, receivedAtMs - Number(msg.t_server_ms)) : NaN,
      updatedAtMs: Date.parse(String(workzone.updated_at || "")) || Date.now(),
      receivedAtMs
    };
  }

  function reconcileLatestWorkzoneVisualFromFleetOverview() {
    const devices = Array.isArray(fleetOverview?.devices) ? fleetOverview.devices : [];
    const activeDevices = devices
      .filter((device) => (
        !!device?.workzone_found
        || !!device?.workzone_tracking
        || !!device?.workzone_active
        || workzoneMachineStateRank(device?.workzone_fused_state) > 0
      ))
      .sort((a, b) => {
        const stateRankA = workzoneMachineStateRank(a?.workzone_fused_state);
        const stateRankB = workzoneMachineStateRank(b?.workzone_fused_state);
        if (stateRankA !== stateRankB) return stateRankB - stateRankA;
        const rankA = (a?.workzone_active ? 3 : (a?.workzone_found ? 2 : (a?.workzone_tracking ? 1 : 0)));
        const rankB = (b?.workzone_active ? 3 : (b?.workzone_found ? 2 : (b?.workzone_tracking ? 1 : 0)));
        if (rankA !== rankB) return rankB - rankA;
        const scoreDiff = Number(b?.workzone_score || 0) - Number(a?.workzone_score || 0);
        if (Math.abs(scoreDiff) > 1e-9) return scoreDiff;
        return String(a?.device_id || "").localeCompare(String(b?.device_id || ""));
      });

    if (!activeDevices.length) {
      latestWorkzoneVisual = null;
      return;
    }

    const best = activeDevices[0];
    const sourceDeviceName = String(best?.device_name || best?.device_id || "another phone").trim() || "another phone";
    const classSummary = String(best?.workzone_class_summary || "").trim();
    const rawDetected = !!best?.workzone_found;
    const fusedState = String(best?.workzone_fused_state || "").trim().toUpperCase() || (rawDetected ? "INSIDE" : "APPROACHING");
    const isDetected = rawDetected || fusedState === "INSIDE";
    const state = isDetected ? "detected" : "tracking";
    latestWorkzoneVisual = {
      title: isDetected ? "Workzone detected" : "Workzone tracking",
      message: classSummary
        ? `${isDetected ? "Workzone detected by" : "Tracking workzone from"} ${sourceDeviceName} (${classSummary}).`
        : `${isDetected ? "Workzone detected by" : "Tracking workzone from"} ${sourceDeviceName}.`,
      state,
      fusedState,
      sourceDeviceName,
      fromSelf: String(best?.device_id || "").trim() === runConfig.device_id,
      score: Number(best?.workzone_score),
      scoreThreshold: Number(best?.workzone_score_threshold),
      maxConfidence: Number(best?.workzone_max_confidence),
      detectionCount: Math.max(0, Number(best?.workzone_detection_count || 0)),
      classSummary,
      frameToAlertMs: Number(best?.workzone_alert_latency_ms),
      frameToResultMs: Number(best?.workzone_pipeline_latency_ms),
      queueWaitMs: Number(best?.workzone_queue_wait_ms),
      dispatchToResultMs: Number(best?.workzone_dispatch_latency_ms),
      inferenceMs: Number(best?.workzone_inference_ms),
      sourceRttMs: Number(best?.rtt_ms),
      approxPhoneReceiveMs: NaN,
      updatedAtMs: Number(best?.workzone_updated_at_ms || fleetOverview?.generated_at_ms || Date.now()),
      receivedAtMs: Date.now()
    };
  }

  function pickWorkzoneAlertVoice(voices) {
    const list = Array.isArray(voices) ? voices : [];
    if (!list.length) return null;
    const preferredNames = ["Samantha", "Ava", "Allison", "Serena", "Victoria", "Karen", "Moira", "Fiona"];
    for (const name of preferredNames) {
      const preferred = list.find((voice) => String(voice?.name || "").toLowerCase() === name.toLowerCase());
      if (preferred) return preferred;
    }
    const localEnglish = list.find((voice) => {
      const lang = String(voice?.lang || "").toLowerCase();
      return voice?.localService && lang.startsWith("en");
    });
    if (localEnglish) return localEnglish;
    const anyEnglish = list.find((voice) => String(voice?.lang || "").toLowerCase().startsWith("en"));
    return anyEnglish || list[0] || null;
  }

  async function waitForWorkzoneVoices(timeoutMs = 2200) {
    const synth = window.speechSynthesis;
    if (!synth || typeof synth.getVoices !== "function") return [];
    const existing = synth.getVoices() || [];
    if (existing.length) return existing;
    if (workzoneVoiceWaitInFlight) return workzoneVoiceWaitInFlight;

    workzoneVoiceWaitInFlight = new Promise((resolve) => {
      let settled = false;
      const finish = (voices) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        try { synth.removeEventListener?.("voiceschanged", handleVoicesChanged); } catch {}
        resolve(Array.isArray(voices) ? voices : []);
      };
      const handleVoicesChanged = () => {
        const next = synth.getVoices() || [];
        if (next.length) finish(next);
      };
      const timeoutId = setTimeout(() => finish(synth.getVoices() || []), Math.max(300, Number(timeoutMs) || 2200));
      try { synth.addEventListener?.("voiceschanged", handleVoicesChanged); } catch {}
      handleVoicesChanged();
    }).finally(() => {
      workzoneVoiceWaitInFlight = null;
    });

    return workzoneVoiceWaitInFlight;
  }

  function clearSpeechResumeTimer(utterance = null) {
    if (utterance && activeSpeechUtterance !== utterance) return;
    if (activeSpeechResumeTimer) {
      clearInterval(activeSpeechResumeTimer);
      activeSpeechResumeTimer = null;
    }
  }

  function retainSpeechUtterance(utterance, synth) {
    activeSpeechUtterance = utterance;
    clearSpeechResumeTimer();
    activeSpeechResumeTimer = setInterval(() => {
      try { synth?.resume?.(); } catch {}
    }, 250);
  }

  function releaseSpeechUtterance(utterance) {
    if (activeSpeechUtterance !== utterance) return;
    activeSpeechUtterance = null;
    clearSpeechResumeTimer();
  }

  function speakPhraseNow(
    text = "Workzone detected",
    { volume = 1, rate = 0.96, pitch = 1.02, timeoutMs = 5200, cancel = true } = {}
  ) {
    const synth = window.speechSynthesis;
    const Utterance = window.SpeechSynthesisUtterance;
    if (!synth || typeof Utterance !== "function") return Promise.resolve(false);

    const phrase = String(text || "Workzone detected").trim() || "Workzone detected";
    const utterance = new Utterance(phrase);
    utterance.lang = "en-US";
    utterance.rate = rate;
    utterance.pitch = pitch;
    utterance.volume = volume;
    const voice = pickWorkzoneAlertVoice(synth.getVoices?.() || []);
    if (voice) utterance.voice = voice;

    if (cancel) {
      try { synth.cancel(); } catch {}
    }
    retainSpeechUtterance(utterance, synth);

    return new Promise((resolve) => {
      let resolved = false;
      const resolveOnce = (value) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeoutId);
        resolve(value);
      };
      const timeoutId = setTimeout(() => {
        releaseSpeechUtterance(utterance);
        resolveOnce(false);
      }, Math.max(800, Number(timeoutMs || 5200)));
      utterance.onstart = () => resolveOnce(true);
      utterance.onboundary = () => resolveOnce(true);
      utterance.onend = () => {
        releaseSpeechUtterance(utterance);
        resolveOnce(true);
      };
      utterance.onerror = () => {
        releaseSpeechUtterance(utterance);
        resolveOnce(false);
      };
      try {
        synth.speak(utterance);
        synth.resume?.();
      } catch {
        releaseSpeechUtterance(utterance);
        resolveOnce(false);
      }
    });
  }

  function unlockVoiceAlertsFromGesture({ phrase = "Voice alerts ready", force = false } = {}) {
    if (workzoneSpeechPrimed && !force) return Promise.resolve(true);
    if (workzoneSpeechPrimeInFlight && !force) return workzoneSpeechPrimeInFlight;
    const spoken = speakPhraseNow(phrase, {
      volume: 0.55,
      rate: 1,
      pitch: 1,
      timeoutMs: 4200
    });
    void ensureAlertMediaPlaybackAnchor({ interactive: true });
    void primeAlertAudioWithOptions({ interactive: true });
    workzoneSpeechPrimeInFlight = spoken.then((primed) => {
      if (primed) workzoneSpeechPrimed = true;
      return primed;
    }).finally(() => {
      workzoneSpeechPrimeInFlight = null;
    });
    return workzoneSpeechPrimeInFlight;
  }

  async function primeWorkzoneSpeechSynthesis({ interactive = false } = {}) {
    if (workzoneSpeechPrimed) return true;
    if (workzoneSpeechPrimeInFlight) return workzoneSpeechPrimeInFlight;
    const synth = window.speechSynthesis;
    const Utterance = window.SpeechSynthesisUtterance;
    if (!synth || typeof Utterance !== "function") return false;

    if (interactive) {
      return unlockVoiceAlertsFromGesture();
    }

    workzoneSpeechPrimeInFlight = (async () => {
      syncPhoneAudioSession({ preferAlertPlayback: true });
      try {
        await waitForWorkzoneVoices(900);
        return true;
      } catch {
        return false;
      } finally {
        workzoneSpeechPrimeInFlight = null;
      }
    })();

    return workzoneSpeechPrimeInFlight;
  }

  async function speakWorkzoneDetectedVoice(text = "Workzone detected") {
    syncPhoneAudioSession({ preferAlertPlayback: true });
    await ensureAlertMediaPlaybackAnchor({});
    await resumeAudioContext();
    const synth = window.speechSynthesis;
    const Utterance = window.SpeechSynthesisUtterance;
    if (!synth || typeof Utterance !== "function") return false;
    await waitForWorkzoneVoices(900);

    try {
      const first = await speakPhraseNow(text, { volume: 1, rate: 0.96, pitch: 1.02, timeoutMs: 5200 });
      if (first) {
        workzoneSpeechPrimed = true;
        return true;
      }
      try { synth.cancel(); } catch {}
      await new Promise((resolve) => setTimeout(resolve, 120));
      const second = await speakPhraseNow(text, { volume: 1, rate: 0.96, pitch: 1.02, timeoutMs: 5200 });
      if (second) workzoneSpeechPrimed = true;
      return second;
    } catch {}
    return false;
  }

  async function playWorkzoneTone({ allowThrottle = true, interactive = false } = {}) {
    const nowMs = Date.now();
    if (allowThrottle && nowMs - lastWorkzoneAlertPlayedAtMs < 800) return true;
    const ready = await primeAlertAudioWithOptions({ interactive });
    if (!ready || !alertAudioCtx) return false;
    lastWorkzoneAlertPlayedAtMs = nowMs;
    const pattern = [
      { delay: 0, duration: 0.18, freq: 659, accentFreq: 988, gain: 0.08 },
      { delay: 0.24, duration: 0.2, freq: 784, accentFreq: 1174, gain: 0.09 },
      { delay: 0.5, duration: 0.28, freq: 1046, accentFreq: 1568, gain: 0.11 }
    ];
    const startedAt = alertAudioCtx.currentTime + 0.02;
    for (const step of pattern) {
      const osc = alertAudioCtx.createOscillator();
      const accentOsc = alertAudioCtx.createOscillator();
      const gain = alertAudioCtx.createGain();
      const t0 = startedAt + step.delay;
      const t1 = t0 + step.duration;
      osc.type = "sine";
      accentOsc.type = "triangle";
      osc.frequency.setValueAtTime(step.freq, t0);
      accentOsc.frequency.setValueAtTime(step.accentFreq, t0);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(step.gain, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t1);
      osc.connect(gain);
      accentOsc.connect(gain);
      gain.connect(alertAudioMasterGain || alertAudioCtx.destination);
      osc.start(t0);
      accentOsc.start(t0);
      osc.stop(t1 + 0.03);
      accentOsc.stop(t1 + 0.03);
      osc.onended = () => {
        try { osc.disconnect(); } catch {}
        try { accentOsc.disconnect(); } catch {}
        try { gain.disconnect(); } catch {}
      };
    }
    return true;
  }

  async function playWorkzoneAnnouncement({ interactive = false, announcementText = "Workzone detected", allowLockedTone = false } = {}) {
    syncPhoneAudioSession({ preferAlertPlayback: true });
    if (!interactive && !workzoneSpeechPrimed) {
      if (allowLockedTone) {
        const toned = await playWorkzoneTone({ allowThrottle: false, interactive: false });
        return { played: toned, mode: toned ? "tone_locked" : "voice_locked" };
      }
      return { played: false, mode: "voice_locked" };
    }
    // Prime the AudioContext and resume all contexts before attempting TTS.
    // On iOS, SpeechSynthesis routes to speaker only when an active AudioContext
    // has already established speaker routing — this is especially critical when
    // the camera is active, which can suspend audio contexts or force earpiece routing.
    await primeAlertAudioWithOptions({ interactive });
    await resumeAudioContext();
    const spoken = await speakWorkzoneDetectedVoice(announcementText);
    if (spoken) return { played: true, mode: "speech" };
    const toned = await playWorkzoneTone({ allowThrottle: false, interactive });
    return { played: toned, mode: toned ? "tone" : "none" };
  }

  async function playWorkzoneAnnouncementFromGesture(announcementText = "Workzone detected") {
    syncPhoneAudioSession({ preferAlertPlayback: true });
    // This must call speechSynthesis.speak() before any await. Safari treats
    // delayed TTS differently from a direct user-gesture media action.
    const spokenPromise = speakPhraseNow(announcementText, {
      volume: 1,
      rate: 0.96,
      pitch: 1.02,
      timeoutMs: 5200
    });
    void ensureAlertMediaPlaybackAnchor({ interactive: true });
    void primeAlertAudioWithOptions({ interactive: true });
    const spoken = await spokenPromise;
    if (spoken) {
      workzoneSpeechPrimed = true;
      return { played: true, mode: "speech" };
    }
    const toned = await playWorkzoneTone({ allowThrottle: false, interactive: true });
    return { played: toned, mode: toned ? "tone" : "none" };
  }

  async function playPermissionRefreshAnnouncement({
    announcementText = "Dashboard requested access. Please refresh the page.",
    interactive = false,
    allowLockedTone = true
  } = {}) {
    const phrase = String(announcementText || "").trim() || "Dashboard requested access. Please refresh the page.";
    syncPhoneAudioSession({ preferAlertPlayback: true });
    if (interactive) {
      // Keep the speechSynthesis call directly in the click stack for Safari/iOS.
      const spokenPromise = speakPhraseNow(phrase, {
        volume: 1,
        rate: 0.98,
        pitch: 1,
        timeoutMs: 5200
      });
      void ensureAlertMediaPlaybackAnchor({ interactive: true });
      void primeAlertAudioWithOptions({ interactive: true });
      const spoken = await spokenPromise;
      if (spoken) {
        workzoneSpeechPrimed = true;
        return { played: true, mode: "speech" };
      }
      const toned = allowLockedTone
        ? await playAlertTone({ allowThrottle: false, interactive: true })
        : false;
      return { played: toned, mode: toned ? "tone" : "none" };
    }
    if (!workzoneSpeechPrimed) {
      const toned = allowLockedTone
        ? await playAlertTone({ allowThrottle: false, interactive: false })
        : false;
      return { played: toned, mode: toned ? "tone_locked" : "voice_locked" };
    }
    await primeAlertAudioWithOptions({ interactive: false });
    await resumeAudioContext();
    const spoken = await speakWorkzoneDetectedVoice(phrase);
    if (spoken) return { played: true, mode: "speech" };
    const toned = await playAlertTone({ allowThrottle: false, interactive: false });
    return { played: toned, mode: toned ? "tone" : "none" };
  }

  async function replayPendingAlertIfPossible() {
    if (!pendingAlertReplay) return;
    const pending = pendingAlertReplay;
    if (Date.now() > Number(pending.expiresAtMs || 0)) {
      pendingAlertReplay = null;
      clearPendingAlertReplaySchedule();
      return;
    }
    let played = false;
    if (isWorkzoneReplayKind(pending.kind)) {
      pending.attempts = Number(pending.attempts || 0) + 1;
      const result = await playWorkzoneAnnouncement({
        interactive: true,
        announcementText: pending.announcementText || buildWorkzoneAnnouncementText(pending.sourceDeviceName)
      });
      played = result.played;
    } else if (pending.kind === "permission_refresh") {
      pending.attempts = Number(pending.attempts || 0) + 1;
      const result = await playPermissionRefreshAnnouncement({
        interactive: true,
        allowLockedTone: false,
        announcementText: pending.announcementText || buildPermissionRefreshAnnouncementText(permissionRefreshNotice?.modalities)
      });
      played = result.mode === "speech";
    } else {
      const ready = await primeAlertAudioWithOptions({ interactive: true });
      if (!ready) return;
      played = await playAlertTone({ allowThrottle: false, interactive: true });
    }
    if (!played) {
      schedulePendingAlertReplay();
      return;
    }
    pendingAlertReplay = null;
    clearPendingAlertReplaySchedule();
    if (pending.kind === "permission_refresh") {
      setAlertFeedback("Dashboard requested access on this phone.", "warning", 4000);
      return;
    }
    if (pending.kind === "workzone_detected") {
      setAlertFeedback("Workzone detected.", "warning", 5000);
      return;
    }
    setAlertFeedback(`Alert from ${pending.sourceDeviceName}.`, "muted");
  }

  async function playAlertTone({ allowThrottle = true, interactive = false } = {}) {
    const nowMs = Date.now();
    if (allowThrottle && nowMs - lastAlertPlayedAtMs < 400) return true;
    const ready = await primeAlertAudioWithOptions({ interactive });
    if (!ready || !alertAudioCtx) return false;
    lastAlertPlayedAtMs = nowMs;
    const pattern = [
      { delay: 0, duration: 0.16, freq: 1046, accentFreq: 1568, gain: 0.10 },
      { delay: 0.22, duration: 0.16, freq: 1046, accentFreq: 1318, gain: 0.10 },
      { delay: 0.44, duration: 0.24, freq: 784, accentFreq: 1174, gain: 0.12 }
    ];
    const startedAt = alertAudioCtx.currentTime + 0.02;
    for (const step of pattern) {
      const osc = alertAudioCtx.createOscillator();
      const accentOsc = alertAudioCtx.createOscillator();
      const gain = alertAudioCtx.createGain();
      const t0 = startedAt + step.delay;
      const t1 = t0 + step.duration;
      osc.type = "square";
      accentOsc.type = "triangle";
      osc.frequency.setValueAtTime(step.freq, t0);
      accentOsc.frequency.setValueAtTime(step.accentFreq, t0);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(step.gain, t0 + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t1);
      osc.connect(gain);
      accentOsc.connect(gain);
      gain.connect(alertAudioMasterGain || alertAudioCtx.destination);
      osc.start(t0);
      accentOsc.start(t0);
      osc.stop(t1 + 0.02);
      accentOsc.stop(t1 + 0.02);
      osc.onended = () => {
        try { osc.disconnect(); } catch {}
        try { accentOsc.disconnect(); } catch {}
        try { gain.disconnect(); } catch {}
      };
    }
    return true;
  }

  async function playRecordingStateCue({ active = false } = {}) {
    const phrase = active ? "Started Recording" : "Stopped Recording";
    syncPhoneAudioSession({ preferAlertPlayback: true });
    await primeAlertAudioWithOptions({});
    await resumeAudioContext();
    const spoken = await speakWorkzoneDetectedVoice(phrase);
    if (spoken) {
      setAlertFeedback(phrase, active ? "success" : "muted", 2200);
      return;
    }
    const played = await playAlertTone({ allowThrottle: false });
    if (played) {
      setAlertFeedback(phrase, active ? "success" : "muted", 2200);
      return;
    }
    setAlertFeedback(
      active ? "Recording started. Sound may be blocked on this phone." : "Recording stopped. Sound may be blocked on this phone.",
      "warning",
      4200
    );
  }

  async function triggerFleetAlert({ kind = "", title = "", message = "", feedbackText = "Sending alert..." } = {}) {
    if (!started || !authState?.joinToken || !ws || ws.readyState !== WebSocket.OPEN) {
      setAlertFeedback("Reconnect to send alerts.", "warning");
      return;
    }
    if (isAlertCoolingDown("generic")) return;
    lastGenericAlertSentAtMs = Date.now();
    suppressSelfGenericAlertUntilMs = lastGenericAlertSentAtMs + 4000;
    scheduleAlertCooldownRefresh();
    setAlertFeedback(String(feedbackText || "Sending alert..."), "muted", 1200);
    playAlertHaptics();
    void playAlertTone({ allowThrottle: false, interactive: true }).then((played) => {
      if (played) {
        suppressSelfGenericAlertUntilMs = Date.now() + 4000;
        return;
      }
      suppressSelfGenericAlertUntilMs = 0;
      setAlertFeedback("Alert sent. Sound may be blocked on this phone; tap once anywhere to unlock audio.", "warning", 5200);
    });
    const payload = {
      type: "fleet_alert",
      device_id: runConfig.device_id
    };
    if (kind) payload.kind = String(kind).trim();
    if (title) payload.title = String(title).trim();
    if (message) payload.message = String(message).trim();
    queueJson(payload);
  }

  async function triggerWorkzoneAlert() {
    if (!started || !authState?.joinToken || !ws || ws.readyState !== WebSocket.OPEN) {
      setAlertFeedback("Reconnect to send alerts.", "warning");
      return;
    }
    if (isAlertCoolingDown("workzone")) return;
    lastWorkzoneAlertSentAtMs = Date.now();
    suppressSelfGenericAlertUntilMs = lastWorkzoneAlertSentAtMs + 4000;
    suppressSelfWorkzonePlaybackUntilMs = lastWorkzoneAlertSentAtMs + 4000;
    scheduleAlertCooldownRefresh();
    const announcementText = buildWorkzoneAnnouncementText(authState?.deviceName || runConfig.device_id, { isSelf: true });
    setAlertFeedback("Sending workzone alert...", "muted", 1400);
    playAlertHaptics();
    void playWorkzoneAnnouncementFromGesture(announcementText).then((result) => {
      if (result.played) {
        suppressSelfWorkzonePlaybackUntilMs = Date.now() + 4000;
        return;
      }
      suppressSelfWorkzonePlaybackUntilMs = 0;
      queuePendingAlertReplay(authState?.deviceName || runConfig.device_id, "workzone_detected", announcementText);
      setAlertFeedback("Workzone alert sent. Sound may be blocked on this phone; tap once anywhere to unlock audio.", "warning", 5600);
    });
    queueJson({
      type: "fleet_alert",
      device_id: runConfig.device_id,
      kind: "workzone_detected",
      title: "Workzone detected",
      message: "Workzone detected."
    });
  }

  async function handleFleetAlert(msg) {
    const alertId = String(msg.alert_id || "").trim();
    const kind = String(msg.kind || "").trim();
    const sourceDeviceId = String(msg.source_device_id || "").trim();
    const sourceDeviceName = String(msg.source_device_name || sourceDeviceId || "another phone").trim();
    const targetCount = Math.max(1, Number(msg.target_count || 0) || 1);
    const fromSelf = !!sourceDeviceId && sourceDeviceId === runConfig.device_id;
    if (alertId) acknowledgeFleetAlert(alertId);
    if (kind === "workzone_detected") {
      updateLatestWorkzoneVisual(msg, { fromSelf });
      renderStatus();
    }
    if (!rememberFleetAlert(alertId)) return;
    if (fromSelf && !kind && Date.now() < suppressSelfGenericAlertUntilMs) {
      setAlertFeedback(`Alert sent to ${targetCount} phone${targetCount === 1 ? "" : "s"}.`, "success", 5000);
      return;
    }
    const shouldPlayHaptics = kind === "permission_refresh" || !fromSelf;
    if (shouldPlayHaptics) playAlertHaptics();
    const workzoneAnnouncementEvent = kind === "workzone_detected"
      ? buildWorkzoneAnnouncementEvent({
          sourceDeviceId,
          sourceDeviceName,
          updatedAtMs: Date.parse(String(msg?.workzone?.updated_at || "")) || Number(msg?.t_server_ms || 0) || Date.now(),
          detectionCount: Number(msg?.workzone?.detection_count || 0),
          score: Number(msg?.workzone?.score),
          classSummary: summarizeWorkzoneClassCounts(msg?.workzone?.class_counts || {}) || String(msg?.workzone?.class_summary || "").trim(),
          sourceGps: msg?.workzone?.source_gps || null
        })
      : null;
    const workzoneAnnouncementText = workzoneAnnouncementEvent?.announcementText || buildWorkzoneAnnouncementText(sourceDeviceName);
    const permissionRefreshAnnouncementText = kind === "permission_refresh"
      ? buildPermissionRefreshAnnouncementText(msg.modalities)
      : "";
    const alertPlayback = kind === "workzone_detected"
      ? ((fromSelf && Date.now() < suppressSelfWorkzonePlaybackUntilMs)
        ? { played: true, mode: "suppressed", deduped: false }
        : await playDedupedWorkzoneAnnouncement(workzoneAnnouncementEvent || { sourceDeviceId, sourceDeviceName }))
      : kind === "permission_refresh"
        ? await playPermissionRefreshAnnouncement({
            announcementText: permissionRefreshAnnouncementText,
            allowLockedTone: true
          })
      : { played: await playAlertTone(), mode: "tone", deduped: false };
    const played = !!alertPlayback.played;
    if (played && alertPlayback.mode !== "pending") pendingAlertReplay = null;
    if (kind === "workzone_detected" && alertPlayback.mode === "pending") return;
    if (kind === "permission_refresh") {
      const title = String(msg.title || "Enable access").trim() || "Enable access";
      const message = String(msg.message || "The dashboard enabled a new permission. Tap Enable Now so Safari can prompt on this phone.").trim();
      setPermissionRefreshNotice({
        title,
        message,
        modalities: msg.modalities
      });
      if (alertPlayback.mode !== "speech") {
        queuePendingAlertReplay("Dashboard", kind, permissionRefreshAnnouncementText);
        setAlertFeedback("Dashboard requested access on this phone. Please refresh the page; if speech was blocked, this phone will retry the voice cue.", "warning", 5600);
      } else {
        setAlertFeedback("Dashboard requested access on this phone.", "warning", 4000);
      }
      return;
    }
    if (kind === "workzone_detected") {
      const title = String(msg.title || "Workzone detected").trim() || "Workzone detected";
      const message = fromSelf
        ? "Workzone detected."
        : String(msg.message || `Workzone detected by ${sourceDeviceName}.`).trim();
      if (fromSelf) {
        if (!played) {
          queuePendingAlertReplay(sourceDeviceName, kind, workzoneAnnouncementText);
          setAlertFeedback(`${title}. Alert sent to ${targetCount} phone${targetCount === 1 ? "" : "s"}. If Safari blocked speech, tap once anywhere on this phone and it will keep retrying the exact phrase.`, "warning", 5600);
          return;
        }
        setAlertFeedback(`${title}. Alert sent to ${targetCount} phone${targetCount === 1 ? "" : "s"}.`, "success", 5000);
        return;
      }
      if (played) {
        setAlertFeedback(message, "warning", 5000);
        return;
      }
      queuePendingAlertReplay(sourceDeviceName, kind, workzoneAnnouncementText);
      setAlertFeedback(`${message} If Safari blocked speech, tap once anywhere on this phone and it will keep retrying the exact phrase.`, "warning", 5600);
      return;
    }
    if (fromSelf) {
      setAlertFeedback(`Alert sent to ${targetCount} phone${targetCount === 1 ? "" : "s"}.`, "success");
      return;
    }
    if (played) {
      setAlertFeedback(`Alert from ${sourceDeviceName}.`, "muted");
      return;
    }
    queuePendingAlertReplay(sourceDeviceName, kind);
    setAlertFeedback(`Alert from ${sourceDeviceName}. Tap once anywhere on this phone if Safari kept sound blocked; it will replay automatically.`, "warning", 5200);
  }

  async function restartPcmCapture() {
    if (pcmRestarting) return;
    pcmRestarting = true;
    try {
      flushPcmChunk(audioCtx?.sampleRate || 48000);
      if (pcmProcessor) {
        try { pcmProcessor.disconnect(); } catch {}
        pcmProcessor.onaudioprocess = null;
      }
      if (pcmSilenceGain) {
        try { pcmSilenceGain.disconnect(); } catch {}
      }
      pcmProcessor = null;
      pcmSilenceGain = null;

      if (!micStream || !micStream.getAudioTracks().some((track) => track.readyState === "live")) {
        if (micStream) {
          for (const track of micStream.getTracks()) track.stop();
        }
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      }
      if (!audioCtx || audioCtx.state === "closed") {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        analyserSource = audioCtx.createMediaStreamSource(micStream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        analyserSource.connect(analyser);
      }
      syncPhoneAudioSession();
      await resumeAudioContext();
      pcmProcessor = audioCtx.createScriptProcessor(2048, 1, 1);
      pcmSilenceGain = audioCtx.createGain();
      pcmSilenceGain.gain.value = 0;
      analyserSource.connect(pcmProcessor);
      pcmProcessor.connect(pcmSilenceGain);
      pcmSilenceGain.connect(audioCtx.destination);
      pcmProcessor.onaudioprocess = onPcmProcess;
      pcmChunkParts = [];
      pcmChunkSamples = 0;
    } catch {
      audioPermissionState = "error";
      renderStatus();
    } finally {
      pcmRestarting = false;
    }
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
      (pos) => emitGpsPosition(pos),
      (err) => {
        gpsPermissionState = normalizeGpsErrorState(err);
        renderStatus();
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
    );
  }

  async function retryGpsAccess() {
    if (!runConfig.streams.gps?.enabled) return;
    if (!navigator.geolocation) {
      gpsPermissionState = "unsupported";
      renderStatus();
      return false;
    }
    if (gpsWatchId != null) {
      try { navigator.geolocation.clearWatch(gpsWatchId); } catch {}
      gpsWatchId = null;
    }
    gpsPermissionState = "unknown";
    renderStatus();
    try {
      const pos = await requestCurrentGpsPosition();
      emitGpsPosition(pos, { rateLimit: false });
      applyGpsConfig();
      renderStatus();
      return true;
    } catch (err) {
      gpsPermissionState = normalizeGpsErrorState(err);
      renderStatus();
      return false;
    }
  }

  function emitGpsPosition(pos, { rateLimit = true } = {}) {
    gpsPermissionState = "granted";
    const hz = Math.max(0.2, Number(runConfig.streams.gps?.rate_hz || 1));
    const now = performance.now();
    if (rateLimit && now - lastGpsSent < 1000 / hz) return;
    lastGpsSent = now;
    lastGpsEventMs = Date.now();
    const lat = Number(pos.coords?.latitude || 0);
    const lon = Number(pos.coords?.longitude || 0);
    const heading_deg = Number(pos.coords?.heading ?? -1);
    if (Number.isFinite(lat) && Number.isFinite(lon) && (Math.abs(lat) > 0.0001 || Math.abs(lon) > 0.0001)) {
      latestOwnGps = { lat, lon, heading_deg, t_ms: Date.now() };
    }
    queueJson({
      type: "gps",
      device_id: runConfig.device_id,
      t_device_ms: now,
      lat,
      lon,
      accuracy_m: Number(pos.coords?.accuracy ?? -1),
      speed_mps: Number(pos.coords?.speed ?? -1),
      heading_deg,
      altitude_m: Number(pos.coords?.altitude ?? -1)
    });
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
        timestamp: Date.now(),
        preview_active: connectedPreviewPeerCount() > 0,
        preview_peer_count: connectedPreviewPeerCount()
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

  function getFullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  async function requestCarViewFullscreen() {
    if (!carViewOverlayEl) return false;
    try {
      if (typeof carViewOverlayEl.requestFullscreen === "function") {
        await carViewOverlayEl.requestFullscreen({ navigationUI: "hide" });
        return true;
      }
      if (typeof carViewOverlayEl.webkitRequestFullscreen === "function") {
        carViewOverlayEl.webkitRequestFullscreen();
        return true;
      }
    } catch {}
    return false;
  }

  async function exitCarViewFullscreen() {
    try {
      if (!getFullscreenElement()) return;
      if (typeof document.exitFullscreen === "function") {
        await document.exitFullscreen();
        return;
      }
      if (typeof document.webkitExitFullscreen === "function") {
        document.webkitExitFullscreen();
      }
    } catch {}
  }

  async function lockCarViewOrientation() {
    try {
      if (screen.orientation && typeof screen.orientation.lock === "function") {
        await screen.orientation.lock("landscape");
      }
    } catch {}
  }

  function unlockCarViewOrientation() {
    try {
      if (screen.orientation && typeof screen.orientation.unlock === "function") {
        screen.orientation.unlock();
      }
    } catch {}
  }

  function ensureCarViewOverlay() {
    if (carViewOverlayEl) return carViewOverlayEl;
    const overlay = document.createElement("div");
    overlay.className = "phone-car-view";
    overlay.hidden = true;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", "Car view");

    const stage = document.createElement("div");
    stage.className = "phone-car-view-stage";

    const video = document.createElement("video");
    video.className = "phone-car-view-video";
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "true");

    const shade = document.createElement("div");
    shade.className = "phone-car-view-shade";
    shade.setAttribute("aria-hidden", "true");

    const hud = document.createElement("div");
    hud.className = "phone-car-view-hud is-out";

    const hudCopy = document.createElement("div");
    hudCopy.className = "phone-car-view-hud-copy";

    const state = document.createElement("div");
    state.className = "phone-car-view-state";
    state.textContent = "OUTSIDE";

    const detail = document.createElement("div");
    detail.className = "phone-car-view-detail";
    detail.textContent = "No active WorkZone detection";

    const meta = document.createElement("div");
    meta.className = "phone-car-view-meta mono";
    meta.textContent = "Camera waiting";

    hudCopy.append(state, detail, meta);

    const hudSide = document.createElement("div");
    hudSide.className = "phone-car-view-side";

    const score = document.createElement("div");
    score.className = "phone-car-view-score mono";
    score.textContent = "Score --";

    const exitBtn = document.createElement("button");
    exitBtn.type = "button";
    exitBtn.className = "phone-car-view-exit";
    exitBtn.textContent = "Exit";
    exitBtn.addEventListener("click", () => { void exitCarView(); });

    hudSide.append(score, exitBtn);
    hud.append(hudCopy, hudSide);

    const cameraState = document.createElement("div");
    cameraState.className = "phone-car-view-camera-state";
    cameraState.textContent = "Camera waiting for dashboard stream";

    stage.append(video, shade, hud, cameraState);
    overlay.appendChild(stage);
    document.body.appendChild(overlay);

    carViewOverlayEl = overlay;
    carViewVideoEl = video;
    carViewHudEl = hud;
    carViewStateEl = state;
    carViewScoreEl = score;
    carViewMetaEl = meta;
    carViewDetailEl = detail;
    carViewCameraStateEl = cameraState;
    return overlay;
  }

  function syncCarViewVideo() {
    if (!carViewVideoEl) return;
    const nextStream = cameraStream || null;
    if (carViewVideoEl.srcObject !== nextStream) {
      carViewVideoEl.srcObject = nextStream;
    }
    if (nextStream) {
      try { void carViewVideoEl.play?.(); } catch {}
    }
  }

  async function enterCarView() {
    if (carViewActive) return;
    ensureCarViewOverlay();
    carViewActive = true;
    if (carViewOverlayEl) carViewOverlayEl.hidden = false;
    document.body.classList.add("phone-car-view-active");
    syncCarViewVideo();
    renderCarViewHud();
    if (carViewStatusTimer) clearInterval(carViewStatusTimer);
    carViewStatusTimer = setInterval(renderCarViewHud, 500);
    renderPrimaryAction();
    const fullscreenPromise = requestCarViewFullscreen();
    const fullscreenStarted = await fullscreenPromise;
    if (fullscreenStarted) await lockCarViewOrientation();
    try { await requestWakeLock(); } catch {}
  }

  async function exitCarView({ skipFullscreenExit = false } = {}) {
    if (!carViewActive && !carViewOverlayEl) return;
    carViewActive = false;
    if (carViewStatusTimer) {
      clearInterval(carViewStatusTimer);
      carViewStatusTimer = null;
    }
    unlockCarViewOrientation();
    if (!skipFullscreenExit) await exitCarViewFullscreen();
    if (carViewVideoEl) {
      try { carViewVideoEl.pause?.(); } catch {}
      carViewVideoEl.srcObject = null;
    }
    if (carViewOverlayEl) carViewOverlayEl.hidden = true;
    document.body.classList.remove("phone-car-view-active");
    renderPrimaryAction();
  }

  function handleCarViewFullscreenChange() {
    if (!carViewActive || !carViewOverlayEl) return;
    const activeFullscreen = getFullscreenElement();
    if (!activeFullscreen) {
      void exitCarView({ skipFullscreenExit: true });
    }
  }

  function normalizeCarViewMachineState(value, fallback = "") {
    const state = String(value || "").trim().toUpperCase();
    if (state === "OUT" || state === "APPROACHING" || state === "INSIDE" || state === "EXITING") return state;
    const fallbackState = String(fallback || "").trim().toLowerCase();
    if (fallbackState === "detected") return "INSIDE";
    if (fallbackState === "tracking") return "APPROACHING";
    return "OUT";
  }

  function resolveCarViewTone(machineState) {
    if (machineState === "INSIDE") return "inside";
    if (machineState === "APPROACHING") return "approaching";
    if (machineState === "EXITING") return "exiting";
    return "out";
  }

  function resolveCarViewStateLabel(machineState) {
    if (machineState === "INSIDE") return "WORK ZONE";
    if (machineState === "APPROACHING") return "APPROACHING";
    if (machineState === "EXITING") return "EXITING";
    return "OUTSIDE";
  }

  function resolveCarViewHudState() {
    const visual = latestWorkzoneVisual;
    const machineState = normalizeCarViewMachineState(
      visual?.fusedState || visual?.machineState || visual?.state,
      visual?.state
    );
    const score = Number(visual?.score);
    const threshold = Number(visual?.scoreThreshold);
    const scoreLabel = Number.isFinite(score)
      ? (Number.isFinite(threshold) && threshold > 0 ? `Score ${score.toFixed(2)} / ${threshold.toFixed(2)}` : `Score ${score.toFixed(2)}`)
      : "Score --";
    const ageMs = visual ? Date.now() - Number(visual.updatedAtMs || visual.receivedAtMs || Date.now()) : NaN;
    const ageLabel = visual ? formatRelativeAgeMs(ageMs) : "";
    const source = visual?.sourceDeviceName
      ? (visual.fromSelf ? `${visual.sourceDeviceName} (this phone)` : visual.sourceDeviceName)
      : "";
    const meta = [
      source ? `Source ${source}` : "",
      ageLabel,
      visual?.classSummary || ""
    ].filter(Boolean).join(" • ");
    return {
      machineState,
      tone: resolveCarViewTone(machineState),
      label: resolveCarViewStateLabel(machineState),
      scoreLabel,
      detail: visual?.message || "No active WorkZone detection",
      meta: meta || (cameraStream ? "Camera live" : "Camera waiting")
    };
  }

  function renderCarViewHud() {
    if (!carViewOverlayEl) return;
    syncCarViewVideo();
    const state = resolveCarViewHudState();
    if (carViewHudEl) carViewHudEl.className = `phone-car-view-hud is-${state.tone}`;
    if (carViewStateEl) carViewStateEl.textContent = state.label;
    if (carViewDetailEl) carViewDetailEl.textContent = state.detail;
    if (carViewMetaEl) carViewMetaEl.textContent = state.meta;
    if (carViewScoreEl) carViewScoreEl.textContent = state.scoreLabel;
    if (carViewCameraStateEl) {
      const cameraLive = !!cameraStream && runConfig.streams.camera.mode !== "off";
      carViewCameraStateEl.hidden = cameraLive;
      carViewCameraStateEl.textContent = cameraLive
        ? ""
        : "Camera waiting for dashboard stream";
    }
  }

  function renderStatus() {
    maybeClearPermissionRefreshNotice();
    renderDeviceIdentity();
    renderJoinValidation();
    renderReadiness();
    renderPrimaryAction();
    renderWorkzoneVisual();
    renderCameraPreviewStatus();
    renderPermissionRefreshModal();
    scheduleFleetOverviewRender();
    if (carViewActive) renderCarViewHud();
  }

  function renderWorkzoneVisual() {
    if (!phoneWorkzoneCard || !phoneWorkzoneTitle || !phoneWorkzoneBadge || !phoneWorkzoneMessage || !phoneWorkzoneMeta || !phoneWorkzoneMetrics) return;
    if (!latestWorkzoneVisual) {
      phoneWorkzoneCard.hidden = true;
      return;
    }
    const ageLabel = formatRelativeAgeMs(Date.now() - Number(latestWorkzoneVisual.updatedAtMs || latestWorkzoneVisual.receivedAtMs || Date.now()));
    const score = Number(latestWorkzoneVisual.score);
    const scoreThreshold = Number(latestWorkzoneVisual.scoreThreshold);
    const maxConfidence = Number(latestWorkzoneVisual.maxConfidence);
    const detectionCount = Number(latestWorkzoneVisual.detectionCount);
    const frameToAlertMs = Number(latestWorkzoneVisual.frameToAlertMs);
    const queueWaitMs = Number(latestWorkzoneVisual.queueWaitMs);
    const inferenceMs = Number(latestWorkzoneVisual.inferenceMs);
    const approxPhoneReceiveMs = Number(latestWorkzoneVisual.approxPhoneReceiveMs);
    const sourceRttMs = Number(latestWorkzoneVisual.sourceRttMs);
    const state = String(latestWorkzoneVisual.state || "detected").toLowerCase();
    const tone = state === "tracking" ? "tracking" : "detected";
    phoneWorkzoneCard.hidden = false;
    phoneWorkzoneCard.className = `card phone-workzone-card is-${tone}`;
    phoneWorkzoneTitle.textContent = latestWorkzoneVisual.title;
    phoneWorkzoneBadge.className = `phone-workzone-badge ${tone}`;
    phoneWorkzoneBadge.textContent = state === "tracking" ? "Tracking" : "Detected";
    phoneWorkzoneMessage.textContent = latestWorkzoneVisual.message;
    phoneWorkzoneMeta.textContent = [
      latestWorkzoneVisual.fromSelf
        ? `Source ${latestWorkzoneVisual.sourceDeviceName} (this phone)`
        : `Source ${latestWorkzoneVisual.sourceDeviceName}`,
      ageLabel || "",
      latestWorkzoneVisual.classSummary || ""
    ].filter(Boolean).join(" • ");
    const metrics = [];
    if (Number.isFinite(score)) {
      metrics.push({ label: "Score", value: Number.isFinite(scoreThreshold) && scoreThreshold > 0 ? `${score.toFixed(2)} / ${scoreThreshold.toFixed(2)}` : score.toFixed(2) });
    }
    if (Number.isFinite(maxConfidence)) {
      metrics.push({ label: "Model Conf", value: maxConfidence.toFixed(2) });
    }
    if (Number.isFinite(detectionCount)) {
      metrics.push({ label: "Detections", value: String(Math.max(0, detectionCount)) });
    }
    if (Number.isFinite(frameToAlertMs)) {
      metrics.push({ label: "Frame->Alert", value: formatLatencyMs(frameToAlertMs) });
    }
    if (Number.isFinite(queueWaitMs)) {
      metrics.push({ label: "Queue", value: formatLatencyMs(queueWaitMs) });
    }
    if (Number.isFinite(inferenceMs)) {
      metrics.push({ label: "Infer", value: formatLatencyMs(inferenceMs) });
    }
    if (Number.isFinite(approxPhoneReceiveMs)) {
      metrics.push({ label: "Phone RX", value: formatLatencyMs(approxPhoneReceiveMs, { approximate: true }) });
    }
    if (Number.isFinite(sourceRttMs)) {
      metrics.push({ label: "RTT", value: formatLatencyMs(sourceRttMs) });
    }
    phoneWorkzoneMetrics.innerHTML = metrics
      .map((metric) => `
        <div class="phone-workzone-metric">
          <span>${metric.label}</span>
          <strong>${metric.value}</strong>
        </div>
      `)
      .join("");
  }

  function renderReadiness() {
    if (!phoneReadinessList || !phoneReadySummary) return;
    const now = Date.now();
    const items = [];
    items.push(
      readinessItem(
        "Session",
        authState?.joinToken && ws && ws.readyState === WebSocket.OPEN ? "ready" : "warning",
        authState?.joinToken
          ? (ws && ws.readyState === WebSocket.OPEN ? "Connected to the dashboard" : "Authorized, waiting for connection")
          : "Tap Start Device to join this session"
      )
    );

    if (reconnectState !== "stable") {
      items.push(
        readinessItem(
          "Device identity",
          reconnectState === "reused" ? "ready" : "warning",
          reconnectState === "reused" ? "Previous device identity reused" : "Server assigned a new device slot"
        )
      );
    }

    if (runConfig.streams.imu.enabled) {
      const imuFresh = ageFresh(lastImuEventMs, now, 5000);
      items.push(readinessItem(
        "Motion",
        imuFresh ? "ready" : motionPermissionState === "denied" || motionPermissionState === "unsupported" ? "error" : "warning",
        imuFresh ? "Sensors are sending motion data" : describeMotionDetail(now)
      ));
    }

    if (runConfig.streams.camera.mode !== "off") {
      const cameraReady = cameraPermissionState === "granted" && !!cameraStream;
      items.push(readinessItem(
        "Camera",
        cameraReady ? "ready" : cameraPermissionState === "denied" ? "error" : "warning",
        cameraPermissionState === "granted"
          ? (cameraStream ? "Camera is ready for live preview" : "Permission granted, waiting for camera")
          : describePermission(cameraPermissionState, "camera")
      ));
    }

    if (runConfig.streams.audio.enabled) {
      items.push(readinessItem(
        "Audio",
        audioPermissionState === "granted" && ageFresh(lastAudioEventMs, now, 6000) ? "ready" : audioPermissionState === "denied" ? "error" : "warning",
        audioPermissionState === "granted"
          ? (ageFresh(lastAudioEventMs, now, 6000) ? "Audio levels are flowing" : "Permission granted, waiting for audio")
          : describePermission(audioPermissionState, "microphone")
      ));
    }

    if (runConfig.streams.gps.enabled) {
      items.push(readinessItem(
        "Location",
        gpsPermissionState === "granted" && ageFresh(lastGpsEventMs, now, 12000) ? "ready" : gpsPermissionState === "denied" ? "error" : "warning",
        gpsPermissionState === "granted"
          ? (ageFresh(lastGpsEventMs, now, 12000) ? "Location fixes are flowing" : "Permission granted, waiting for GPS fix")
          : describePermission(gpsPermissionState, "location")
      ));
    }

    const readyCount = items.filter((item) => item.state === "ready").length;
    const blocked = items.filter((item) => item.state !== "ready");
    phoneReadySummary.textContent = blocked.length
      ? `${blocked.length} thing${blocked.length > 1 ? "s" : ""} still need attention`
      : "This device is ready";
    if (phoneReadyMissing) {
      phoneReadyMissing.textContent = blocked.length
        ? blocked.map((item) => item.label).join(" • ")
        : `${readyCount}/${items.length} checks look good`;
    }
    phoneReadinessList.innerHTML = "";
    for (const item of items) {
      const li = document.createElement("li");
      li.className = item.state;
      li.innerHTML = `
        <span class="icon" aria-hidden="true">${item.state === "ready" ? "OK" : item.state === "error" ? "!" : "..."}</span>
        <div class="checklist-copy">
          <strong>${item.label}</strong>
          <p>${item.detail}</p>
        </div>
        <span class="checklist-state">${item.state === "ready" ? "Ready" : item.state === "error" ? "Fix" : "Waiting"}</span>
      `;
      phoneReadinessList.appendChild(li);
    }

    if (phonePermissionActions) {
      phonePermissionActions.innerHTML = "";
      phonePermissionActions.hidden = true;
      if (runConfig.streams.gps.enabled && ["denied", "error", "timeout", "unavailable"].includes(gpsPermissionState)) {
        const note = document.createElement("p");
        note.className = "phone-status-note";
        note.textContent = gpsPermissionState === "denied"
          ? "Retry Location will re-ask if Safari still allows a prompt. If this site is blocked in Safari or iPhone settings, re-enable Location there first."
          : "Retry Location will issue a fresh location request. If Safari has this site blocked, re-enable Location there first.";
        const btn = document.createElement("button");
        btn.className = "btn btn-alt btn-small";
        btn.textContent = "Retry Location";
        btn.addEventListener("click", () => {
          void playPermissionRefreshAnnouncement({
            interactive: true,
            allowLockedTone: false,
            announcementText: buildPermissionRefreshAnnouncementText(["location"])
          });
          void retryGpsAccess();
        });
        phonePermissionActions.append(note, btn);
        phonePermissionActions.hidden = false;
      }
    }
  }

  function renderDeviceIdentity() {
    if (!deviceIdentityCard || !deviceIdentityName || !deviceIdentityType) return;
    const name = sanitizeDeviceNameInput(deviceNameInput?.value || authState?.deviceName || "");
    deviceIdentityName.textContent = name || "Not connected";
    deviceIdentityType.textContent = detectDeviceType();
    deviceIdentityCard.style.display = authState?.joinToken ? "" : "none";
  }

  function renderJoinFields() {
    const savedName = localStorage.getItem("d3c_phone_device_name") || "";
    const savedCode = localStorage.getItem("d3c_phone_join_code") || "";
    const qp = new URLSearchParams(location.search);
    const urlCode = normalizeJoinCode(qp.get("join_code") || qp.get("code") || "").slice(0, 6);
    if (deviceNameInput) deviceNameInput.value = savedName;
    if (joinCodeInput) joinCodeInput.value = urlCode || normalizeJoinCode(savedCode).slice(0, 6);
    if (urlCode) localStorage.setItem("d3c_phone_join_code", urlCode);
    updateJoinFieldLock();
  }

  function persistJoinFields(deviceName, joinCode) {
    localStorage.setItem("d3c_phone_device_name", deviceName);
    localStorage.setItem("d3c_phone_join_code", joinCode);
  }

  function setJoinStatus(text, isError = false) {
    if (!joinStatus) return;
    joinStatus.textContent = text;
    joinStatus.classList.toggle("join-status-error", isError);
  }

  function setConnectionUi(isConnected, shortLabel) {
    if (connStatus) {
      connStatus.textContent = isConnected ? "Connected" : "Disconnected";
    }
    if (disconnectBtn) {
      disconnectBtn.textContent = isConnected ? "Disconnect" : "Reconnect";
      disconnectBtn.title = isConnected ? "Disconnect from session" : "Reconnect to session";
    }
    renderPrimaryAction(shortLabel);
  }

  function renderPrimaryAction(connectionLabel = "") {
    if (!primaryActionArea || !startBtn) return;
    const authorized = !!authState?.joinToken;
    const connected = !!(ws && ws.readyState === WebSocket.OPEN);
    const recording = isSessionRecording();
    const canStartDevice = !started;
    const hasDeviceName = !!sanitizeDeviceNameInput(deviceNameInput?.value);
    const hasJoinCode = isJoinCodeValid(joinCodeInput?.value);
    const disabled = !hasDeviceName || !hasJoinCode;

    startBtn.style.display = canStartDevice ? "" : "none";
    startBtn.disabled = canStartDevice ? disabled : true;

    const existing = primaryActionArea.querySelector(".waiting-state");
    if (existing) existing.remove();
    const existingHint = primaryActionArea.querySelector(".primary-action-hint");
    if (existingHint) existingHint.remove();
    const existingQuickActions = primaryActionArea.querySelector(".phone-quick-actions");
    if (existingQuickActions) existingQuickActions.remove();

    if (canStartDevice) {
      const hint = document.createElement("div");
      hint.className = "primary-action-hint";
      if (!hasDeviceName && !hasJoinCode) {
        hint.textContent = "Enter a device name and a valid 6-character join code to continue.";
      } else if (!hasDeviceName) {
        hint.textContent = "Enter a device name to continue.";
      } else if (!hasJoinCode) {
        hint.textContent = "Enter the 6-character join code from the dashboard.";
      } else {
        hint.textContent = "Ready to join this session.";
      }
      primaryActionArea.appendChild(hint);
      return;
    }

    const state = document.createElement("div");
    state.className = `waiting-state ${recording ? "recording" : "waiting"}`;
    const title = recording ? "Recording Active" : "Session Idle";
    const body = recording
      ? "Dashboard recording is active. Keep this page open and in the foreground."
      : authorized && connected
        ? "Dashboard must start recording first."
        : authorized
          ? `Connecting${connectionLabel ? ` (${connectionLabel})` : ""}.`
          : "Device authorization is still in progress.";
    state.innerHTML = `
      <div class="icon">${recording ? "⏺" : "⏳"}</div>
      <div>
        <h3>${title}</h3>
        <p>${body}</p>
      </div>
    `;
    primaryActionArea.appendChild(state);

    const actions = document.createElement("div");
    actions.className = "phone-quick-actions";
    const alertBtn = document.createElement("button");
    alertBtn.type = "button";
    alertBtn.className = "btn btn-alt btn-small phone-alert-btn";
    const genericAlertCoolingDown = isAlertCoolingDown("generic");
    const workzoneAlertCoolingDown = isAlertCoolingDown("workzone");
    alertBtn.textContent = genericAlertCoolingDown ? "Alerting..." : "Alert";
    alertBtn.disabled = !connected || genericAlertCoolingDown;
    alertBtn.addEventListener("click", () => { void triggerFleetAlert(); });
    const workzoneAlertBtn = document.createElement("button");
    workzoneAlertBtn.type = "button";
    workzoneAlertBtn.className = "btn btn-alt btn-small phone-alert-btn";
    workzoneAlertBtn.textContent = workzoneAlertCoolingDown ? "Alerting..." : "Workzone Alert";
    workzoneAlertBtn.disabled = !connected || workzoneAlertCoolingDown;
    workzoneAlertBtn.addEventListener("click", () => { void triggerWorkzoneAlert(); });
    const workzoneToggleBtn = document.createElement("button");
    workzoneToggleBtn.type = "button";
    workzoneToggleBtn.className = `btn btn-small phone-alert-btn${workzoneAlertsEnabled ? "" : " btn-muted"}`;
    workzoneToggleBtn.textContent = workzoneAlertsEnabled ? "Workzone On" : "Workzone Off";
    workzoneToggleBtn.title = workzoneAlertsEnabled ? "Tap to mute workzone alerts" : "Tap to enable workzone alerts";
    workzoneToggleBtn.addEventListener("click", () => {
      workzoneAlertsEnabled = !workzoneAlertsEnabled;
      renderStatus();
    });
    const carViewBtn = document.createElement("button");
    carViewBtn.type = "button";
    carViewBtn.className = "btn btn-alt btn-small phone-car-view-btn";
    carViewBtn.textContent = carViewActive ? "Car View Active" : "Car View";
    carViewBtn.disabled = carViewActive || !cameraStream;
    carViewBtn.title = cameraStream
      ? "Open full-screen dashcam HUD"
      : "Camera must be live before entering Car View";
    carViewBtn.addEventListener("click", () => { void enterCarView(); });
    const hint = document.createElement("div");
    hint.className = `phone-alert-feedback ${alertFeedbackTone}`;
    hint.textContent = alertFeedbackText || (connected ? "Alert plays immediately on this phone and all connected phones." : "Reconnect to send alerts.");
    actions.append(alertBtn, workzoneAlertBtn, workzoneToggleBtn, carViewBtn, hint);
    primaryActionArea.appendChild(actions);
  }

  function renderCameraPreviewStatus() {
    if (!cameraPreviewBadge || !cameraPreviewFps || !cameraPreviewMeta) return;
    const active = runConfig.streams.camera.mode !== "off";
    const streaming = active && !!cameraStream;
    const width = Number(previewEl?.videoWidth || 0);
    const height = Number(previewEl?.videoHeight || 0);
    const previewFps = getPreviewCameraFps();
    const snapshotFps = getSnapshotLoopFps();
    const recordFps = getRecordingCameraFps();
    const recordingCaptureActive = sessionRecordingActive && !!runConfig.streams.camera?.record;
    const directRecordingActive = isDirectCameraRecorderActive() && !cameraVideoRecorderFallback;
    const directRecordingLabel = directRecordingActive ? `${recordFps} FPS direct record` : `${recordFps} FPS record`;
    cameraPreviewBadge.textContent = streaming ? "LIVE" : (active ? "WAITING" : "OFF");
    cameraPreviewBadge.className = `badge ${streaming ? "live" : active ? "pending" : "off"}`;
    cameraPreviewFps.textContent = streaming
      ? (connectedPreviewPeerCount() > 0
        ? (recordingCaptureActive ? (directRecordingActive ? "RTC + VIDEO REC" : `RTC + ${recordFps} REC`) : "RTC")
        : (recordingCaptureActive && directRecordingActive ? `${previewFps} FPS + VIDEO REC` : `${snapshotFps} FPS`))
      : "0 FPS";
    const parts = [];
    parts.push(`Camera: ${active
      ? (connectedPreviewPeerCount() > 0
        ? (recordingCaptureActive ? `WebRTC live / ${directRecordingLabel}` : "WebRTC live")
        : (recordingCaptureActive && directRecordingActive ? `${previewFps} FPS preview / ${directRecordingLabel}` : `${snapshotFps} FPS preview`))
      : "Off"}`);
    parts.push(width && height ? `Resolution: ${width}x${height}` : "Resolution: --");
    parts.push(`Facing: ${cameraFacingMode === "user" ? "Front" : "Rear"}`);
    cameraPreviewMeta.innerHTML = parts.map((part) => `<span>${part}</span>`).join("<span>•</span>");
    if (cameraFlipBtn) cameraFlipBtn.disabled = !active;
    if (carViewActive) renderCarViewHud();
  }

  function renderJoinValidation() {
    if (!joinValidation) return;
    const code = normalizeJoinCode(joinCodeInput?.value).slice(0, 6);
    const valid = isJoinCodeValid(code);
    if (!joinCodeTouched) {
      joinValidation.textContent = "";
      joinValidation.className = "phone-validation-message";
      return;
    }
    joinValidation.textContent = valid ? "✓ Valid code" : "Code must be 6 characters";
    joinValidation.className = `phone-validation-message ${valid ? "success" : ""}`;
  }

  function updateJoinFieldLock() {
    const locked = !!started;
    if (deviceNameInput) deviceNameInput.readOnly = locked;
    if (joinCodeInput) joinCodeInput.readOnly = locked;
  }

  function isSessionRecording() {
    return sessionRecordingActive;
  }

  function detectDeviceType() {
    const ua = navigator.userAgent || "";
    if (/iPhone/i.test(ua)) return "iPhone";
    if (/iPad/i.test(ua)) return "iPad";
    if (/Android/i.test(ua)) return "Android";
    return "Phone";
  }

  function describePermission(state, label) {
    if (state === "denied") return `${label} access denied`;
    if (state === "granted") return `${label} ready`;
    if (state === "idle") return `${label} off`;
    if (state === "unsupported") return `${label} unsupported`;
    if (state === "unavailable") return `${label} unavailable`;
    if (state === "timeout") return `${label} timed out`;
    if (state === "error") return `${label} request failed`;
    return `${label} pending`;
  }

  function normalizeGpsErrorState(err) {
    const code = Number(err?.code || 0);
    if (code === 1) return "denied";
    if (code === 2) return "unavailable";
    if (code === 3) return "timeout";
    return "error";
  }

  function describeMotionDetail(now = Date.now()) {
    if (!runConfig.streams.imu.enabled) return "Disabled in session plan";
    if (ageFresh(lastImuEventMs, now, 5000)) return "Motion events flowing";
    if (motionPermissionState === "denied") return "Motion access denied";
    if (motionPermissionState === "unsupported") return "Browser is not exposing motion sensors";
    if (motionPermissionState === "granted") return "Permission granted, waiting for motion";
    if (motionPermissionState === "implicit") return "Motion pending";
    return "Motion permission pending";
  }

  function setPermissionRefreshNotice(notice) {
    const title = String(notice?.title || "").trim();
    const message = String(notice?.message || "").trim();
    const modalities = normalizePermissionModalities(notice?.modalities);
    permissionRefreshNotice = {
      title: title || "Enable access",
      message: message || "The dashboard enabled a new permission. Tap Enable Now so Safari can prompt on this phone.",
      modalities
    };
    permissionRefreshBusy = false;
    permissionRefreshStatusText = buildPermissionRefreshStatusText(modalities);
    renderStatus();
  }

  function clearPermissionRefreshNotice() {
    if (!permissionRefreshNotice) return;
    permissionRefreshNotice = null;
    permissionRefreshBusy = false;
    permissionRefreshStatusText = "";
    renderStatus();
  }

  function maybeClearPermissionRefreshNotice() {
    if (!permissionRefreshNotice?.modalities?.length) return;
    if (permissionRefreshNotice.modalities.every((modality) => isPermissionModalityReady(modality))) {
      permissionRefreshNotice = null;
      permissionRefreshBusy = false;
      permissionRefreshStatusText = "";
    }
  }

  function normalizePermissionModalities(values) {
    return [...new Set((Array.isArray(values) ? values : [])
      .map((value) => String(value || "").trim().toLowerCase())
      .filter((value) => ["camera", "audio", "location"].includes(value)))];
  }

  function joinPermissionSpeechLabels(labels) {
    const clean = (Array.isArray(labels) ? labels : []).map((label) => String(label || "").trim()).filter(Boolean);
    if (!clean.length) return "access";
    if (clean.length === 1) return clean[0];
    if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;
    return `${clean.slice(0, -1).join(", ")}, and ${clean[clean.length - 1]}`;
  }

  function permissionModalitySpeechLabel(modality) {
    if (modality === "camera") return "camera";
    if (modality === "audio") return "microphone";
    if (modality === "location") return "location";
    return "access";
  }

  function buildPermissionRefreshAnnouncementText(modalities) {
    const labels = normalizePermissionModalities(modalities).map((modality) => permissionModalitySpeechLabel(modality));
    const subject = joinPermissionSpeechLabels(labels);
    return `Dashboard requested ${subject} access. Please refresh the page.`;
  }

  function isPermissionModalityReady(modality) {
    if (modality === "camera") {
      return runConfig.streams.camera.mode === "off" || (cameraPermissionState === "granted" && !!cameraStream);
    }
    if (modality === "audio") {
      return !runConfig.streams.audio.enabled || audioPermissionState === "granted";
    }
    if (modality === "location") {
      return !runConfig.streams.gps.enabled || gpsPermissionState === "granted";
    }
    return true;
  }

  function renderPermissionRefreshModal() {
    if (!permissionRefreshModal || !permissionRefreshModalTitle || !permissionRefreshModalMessage || !permissionRefreshModalMeta || !permissionRefreshModalAction) {
      return;
    }
    const active = !!permissionRefreshNotice;
    permissionRefreshModal.hidden = !active;
    document.body.classList.toggle("phone-modal-open", active);
    if (!active) return;
    permissionRefreshModalTitle.textContent = permissionRefreshNotice.title || "Enable access";
    permissionRefreshModalMessage.textContent = permissionRefreshNotice.message;
    permissionRefreshModalMeta.textContent = permissionRefreshStatusText || buildPermissionRefreshStatusText(permissionRefreshNotice.modalities);
    permissionRefreshModalAction.textContent = permissionRefreshBusy
      ? "Requesting..."
      : buildPermissionRefreshActionLabel(permissionRefreshNotice.modalities);
    permissionRefreshModalAction.disabled = !!permissionRefreshBusy;
    if (permissionRefreshModalRefresh) permissionRefreshModalRefresh.disabled = !!permissionRefreshBusy;
    if (permissionRefreshModalDismiss) permissionRefreshModalDismiss.disabled = !!permissionRefreshBusy;
  }

  function buildPermissionRefreshActionLabel(modalities) {
    const labels = normalizePermissionModalities(modalities).map((modality) => permissionModalityLabel(modality));
    if (!labels.length) return "Enable Now";
    if (labels.length === 1) return `Enable ${labels[0]}`;
    if (labels.length === 2) return `Enable ${labels[0]} + ${labels[1]}`;
    return "Enable Requested Access";
  }

  function buildPermissionRefreshStatusText(modalities) {
    const parts = normalizePermissionModalities(modalities).map((modality) => {
      return `${permissionModalityLabel(modality)}: ${permissionModalityStatus(modality)}`;
    });
    return parts.length
      ? parts.join(" • ")
      : "Tap Enable Now to request access on this phone.";
  }

  function permissionModalityLabel(modality) {
    if (modality === "camera") return "Camera";
    if (modality === "audio") return "Mic";
    if (modality === "location") return "Location";
    return "Access";
  }

  function permissionModalityStatus(modality) {
    if (isPermissionModalityReady(modality)) return "ready";
    if (modality === "camera") return describePermission(cameraPermissionState, "camera");
    if (modality === "audio") return describePermission(audioPermissionState, "microphone");
    if (modality === "location") return describePermission(gpsPermissionState, "location");
    return "pending";
  }

  async function handlePermissionRefreshAction() {
    if (!permissionRefreshNotice || permissionRefreshBusy) return;
    const requestedModalities = normalizePermissionModalities(permissionRefreshNotice.modalities);
    void playPermissionRefreshAnnouncement({
      interactive: true,
      allowLockedTone: false,
      announcementText: buildPermissionRefreshAnnouncementText(requestedModalities)
    });
    permissionRefreshBusy = true;
    permissionRefreshStatusText = "Requesting access on this phone...";
    renderPermissionRefreshModal();

    try {
      await primeAlertAudio();
      await applyConfig();
      if (permissionRefreshNotice?.modalities?.includes("location") && runConfig.streams.gps?.enabled && !isPermissionModalityReady("location")) {
        await retryGpsAccess();
      }
    } finally {
      permissionRefreshBusy = false;
    }

    maybeClearPermissionRefreshNotice();
    if (!permissionRefreshNotice) {
      setAlertFeedback("Requested access is ready.", "success");
      renderStatus();
      return;
    }
    permissionRefreshStatusText = `${buildPermissionRefreshStatusText(permissionRefreshNotice.modalities)}. If Safari still does not prompt, refresh this page or re-enable the permission in Safari/iPhone settings.`;
    renderStatus();
  }

  function requestCurrentGpsPosition() {
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 10000
      });
    });
  }

  function handleForcedDisconnect(msg) {
    const message = String(msg?.message || "Dashboard removed this phone from the session. Tap Start Device to join again.").trim();
    clearPermissionRefreshNotice();
    setAlertFeedback(message, "warning", 5000);
    wsClient?.disconnect(true);
    ws = null;
    stopFrameLoop();
    stopCamera();
    stopAudioLoop();
    if (micStream) {
      for (const track of micStream.getTracks()) track.stop();
      micStream = null;
    }
    if (audioCtx) {
      try { audioCtx.close(); } catch {}
      audioCtx = null;
      analyserSource = null;
      analyser = null;
      pcmProcessor = null;
      pcmSilenceGain = null;
      pcmChunkParts = [];
      pcmChunkSamples = 0;
    }
    syncPhoneAudioSession();
    if (gpsWatchId != null && navigator.geolocation) {
      try { navigator.geolocation.clearWatch(gpsWatchId); } catch {}
    }
    gpsWatchId = null;
    started = false;
    authState = null;
    sessionRecordingActive = false;
    hasSeenRecordingState = false;
    runConfig = mergeRunConfig({ device_id: runConfig.device_id });
    closeAllPreviewPeers("removed_by_dashboard");
    lastPreviewStatusSent = "";
    updateJoinFieldLock();
    setConnectionUi(false, "Disconnected");
    setJoinStatus(message, true);
    renderStatus();
  }

  async function ensureCameraStream() {
    if (cameraStream) return cameraStream;
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: cameraFacingMode }, audio: false });
      cameraVideoRecorderFallback = false;
      cameraPermissionState = "granted";
      previewEl.srcObject = cameraStream;
      try { await previewEl.play?.(); } catch {}
      emitPreviewStatus(true);
      return cameraStream;
    } catch {
      cameraPermissionState = "denied";
      emitPreviewStatus(true);
      return null;
    }
  }

  function previewPeerTransportState(entry) {
    const state = entry?.pc?.connectionState || entry?.pc?.iceConnectionState || "new";
    return String(state || "new");
  }

  function previewPeerIsConnected(entry) {
    const states = [entry?.pc?.connectionState, entry?.pc?.iceConnectionState]
      .map((value) => String(value || ""))
      .filter(Boolean);
    return states.includes("connected") || states.includes("completed");
  }

  function connectedPreviewPeerCount() {
    let count = 0;
    for (const entry of previewPeers.values()) {
      if (entry.connected) count += 1;
    }
    return count;
  }

  function emitPreviewStatus(force = false) {
    if (!started || !ws || ws.readyState !== WebSocket.OPEN) return;
    const payload = {
      active: connectedPreviewPeerCount() > 0,
      peer_count: connectedPreviewPeerCount()
    };
    const sig = JSON.stringify(payload);
    if (!force && sig === lastPreviewStatusSent) return;
    lastPreviewStatusSent = sig;
    queueJson({
      type: "preview_status",
      device_id: runConfig.device_id,
      active: payload.active,
      peer_count: payload.peer_count
    });
  }

  function createPreviewPeer(dashboardId) {
    if (typeof RTCPeerConnection !== "function") return null;
    const pc = new RTCPeerConnection({ iceServers: PREVIEW_ICE_SERVERS });
    const entry = {
      dashboardId,
      pc,
      sender: null,
      connected: false,
      pendingIce: []
    };
    const syncState = () => {
      const nextConnected = previewPeerIsConnected(entry);
      if (entry.connected !== nextConnected) {
        entry.connected = nextConnected;
        updateCameraTransport();
        emitPreviewStatus(true);
        renderStatus();
      }
      const state = previewPeerTransportState(entry);
      if (state === "failed" || state === "closed") {
        closePreviewPeer(dashboardId, { reason: "preview_failed" });
      }
    };
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      queueJson({
        type: "webrtc_signal",
        device_id: runConfig.device_id,
        dashboard_id: dashboardId,
        signal: {
          type: "ice",
          candidate: ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate
        }
      });
    };
    pc.onconnectionstatechange = syncState;
    pc.oniceconnectionstatechange = syncState;
    previewPeers.set(dashboardId, entry);
    updateCameraTransport();
    emitPreviewStatus(true);
    return entry;
  }

  function ensurePreviewPeer(dashboardId) {
    const key = String(dashboardId || "").trim();
    if (!key) return null;
    const existing = previewPeers.get(key);
    if (existing) return existing;
    return createPreviewPeer(key);
  }

  function syncPreviewTrack(entry) {
    if (!entry?.pc) return;
    const track = cameraStream?.getVideoTracks?.()[0] || null;
    if (!track) {
      if (entry.sender) entry.sender.replaceTrack(null).catch(() => {});
      return;
    }
    if (!entry.sender) {
      entry.sender = entry.pc.addTrack(track, cameraStream);
      return;
    }
    if (entry.sender.track === track) return;
    entry.sender.replaceTrack(track).catch(() => {});
  }

  function syncPreviewTracks() {
    for (const entry of previewPeers.values()) syncPreviewTrack(entry);
  }

  async function flushPreviewIce(entry) {
    if (!entry?.pc || !entry.pendingIce.length) return;
    while (entry.pendingIce.length) {
      const candidate = entry.pendingIce.shift();
      try {
        await entry.pc.addIceCandidate(candidate);
      } catch {}
    }
  }

  function closePreviewPeer(dashboardId, opts = {}) {
    const key = String(dashboardId || "").trim();
    const entry = previewPeers.get(key);
    if (!entry) return;
    previewPeers.delete(key);
    const wasConnected = entry.connected;
    entry.connected = false;
    try {
      entry.pc.onicecandidate = null;
      entry.pc.onconnectionstatechange = null;
      entry.pc.oniceconnectionstatechange = null;
      entry.pc.close();
    } catch {}
    if (opts.notify) {
      queueJson({
        type: "webrtc_signal",
        device_id: runConfig.device_id,
        dashboard_id: key,
        signal: {
          type: "disconnect",
          reason: String(opts.reason || "preview_closed")
        }
      });
    }
    if (wasConnected) {
      updateCameraTransport();
      emitPreviewStatus(true);
      renderStatus();
      return;
    }
    updateCameraTransport();
    emitPreviewStatus(true);
  }

  function closeAllPreviewPeers(reason = "preview_reset", notify = false) {
    for (const dashboardId of [...previewPeers.keys()]) {
      closePreviewPeer(dashboardId, { reason, notify });
    }
  }

  async function handlePreviewSignal(msg) {
    const dashboardId = String(msg.dashboard_id || "").trim();
    const signal = msg.signal && typeof msg.signal === "object" ? msg.signal : null;
    if (!dashboardId || !signal) return;
    if (signal.type === "disconnect") {
      closePreviewPeer(dashboardId, { reason: signal.reason || "remote_disconnect" });
      return;
    }
    if (signal.type === "offer") {
      if (runConfig.streams.camera.mode === "off") {
        queueJson({
          type: "webrtc_signal",
          device_id: runConfig.device_id,
          dashboard_id: dashboardId,
          signal: { type: "unavailable", reason: "camera_disabled" }
        });
        return;
      }
      const stream = await ensureCameraStream();
      if (!stream) {
        queueJson({
          type: "webrtc_signal",
          device_id: runConfig.device_id,
          dashboard_id: dashboardId,
          signal: { type: "unavailable", reason: "camera_unavailable" }
        });
        return;
      }
      const entry = ensurePreviewPeer(dashboardId);
      if (!entry?.pc) return;
      syncPreviewTrack(entry);
      try {
        await entry.pc.setRemoteDescription({ type: "offer", sdp: String(signal.sdp || "") });
        await flushPreviewIce(entry);
        const answer = await entry.pc.createAnswer();
        await entry.pc.setLocalDescription(answer);
        queueJson({
          type: "webrtc_signal",
          device_id: runConfig.device_id,
          dashboard_id: dashboardId,
          signal: { type: "answer", sdp: String(entry.pc.localDescription?.sdp || answer.sdp || "") }
        });
      } catch {
        closePreviewPeer(dashboardId, { reason: "answer_failed" });
      }
      return;
    }
    if (signal.type === "ice") {
      const entry = ensurePreviewPeer(dashboardId);
      if (!entry?.pc || !signal.candidate) return;
      const candidate = signal.candidate;
      if (!entry.pc.remoteDescription) {
        entry.pendingIce.push(candidate);
        return;
      }
      try {
        await entry.pc.addIceCandidate(candidate);
      } catch {}
    }
  }

  function queueJson(obj) {
    wsClient?.sendJson(obj);
  }

  function sendBinaryMessage(header, buffer, { maxBufferedBytes = CAMERA_BINARY_BUFFER_LIMIT_BYTES } = {}) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !header || !buffer) return false;
    const size = Number(buffer.byteLength || buffer.length || 0);
    if (size > 0 && (ws.bufferedAmount + size) > maxBufferedBytes) return false;
    try {
      ws.send(JSON.stringify(header));
      ws.send(buffer);
      return true;
    } catch {
      return false;
    }
  }

  function resolveDirectCameraRecorderMimeType() {
    if (typeof MediaRecorder !== "function" || typeof MediaRecorder.isTypeSupported !== "function") return "";
    const candidates = [
      "video/mp4;codecs=avc1.42E01E",
      "video/mp4",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm"
    ];
    for (const candidate of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(candidate)) return candidate;
      } catch {}
    }
    return "";
  }

  function parseVideoBitsPerSecond(value) {
    const text = String(value || "").trim().toUpperCase();
    const match = text.match(/^(\d+(?:\.\d+)?)([KMG])?$/);
    if (!match) return 0;
    const num = Number(match[1]);
    if (!Number.isFinite(num) || num <= 0) return 0;
    const scale = match[2] === "G" ? 1_000_000_000 : match[2] === "M" ? 1_000_000 : match[2] === "K" ? 1_000 : 1;
    return Math.round(num * scale);
  }

  function resetDirectCameraRecorderState() {
    cameraVideoRecorder = null;
    cameraVideoRecorderMimeType = "";
    cameraVideoRecorderStream = null;
    cameraVideoRecorderStartDeviceMs = 0;
    cameraVideoRecorderLastChunkDeviceMs = 0;
    cameraVideoRecorderChunkIndex = 0;
    cameraVideoRecorderStopPromise = null;
    cameraVideoRecorderSendChain = Promise.resolve();
  }

  async function startDirectCameraRecorder() {
    if (!cameraStream || typeof MediaRecorder !== "function") return false;
    if (isDirectCameraRecorderActive() && cameraVideoRecorderStream === cameraStream) return true;
    if (isDirectCameraRecorderActive()) {
      await stopDirectCameraRecorder();
    }

    const preferredMimeType = resolveDirectCameraRecorderMimeType();
    const options = {};
    if (preferredMimeType) options.mimeType = preferredMimeType;
    const bitsPerSecond = parseVideoBitsPerSecond(runConfig.streams.camera?.video_bitrate);
    if (bitsPerSecond > 0) options.videoBitsPerSecond = bitsPerSecond;

    let recorder = null;
    try {
      recorder = Object.keys(options).length ? new MediaRecorder(cameraStream, options) : new MediaRecorder(cameraStream);
    } catch {
      try {
        recorder = new MediaRecorder(cameraStream);
      } catch {
        cameraVideoRecorderFallback = true;
        renderStatus();
        updateCameraTransport();
        return false;
      }
    }

    cameraVideoRecorder = recorder;
    cameraVideoRecorderStream = cameraStream;
    cameraVideoRecorderMimeType = String(recorder.mimeType || preferredMimeType || "");
    cameraVideoRecorderStartDeviceMs = getDeviceMonoMs();
    cameraVideoRecorderLastChunkDeviceMs = cameraVideoRecorderStartDeviceMs;
    cameraVideoRecorderChunkIndex = 0;
    cameraVideoRecorderSendChain = Promise.resolve();
    cameraVideoRecorderStopPromise = new Promise((resolve) => {
      recorder.addEventListener("stop", () => resolve(true), { once: true });
      recorder.addEventListener("error", () => resolve(false), { once: true });
    });

    recorder.addEventListener("dataavailable", (ev) => {
      const blob = ev.data;
      if (!blob || !blob.size) return;
      const chunkEndDeviceMs = getDeviceMonoMs();
      const previousChunkEndMs = cameraVideoRecorderLastChunkDeviceMs || cameraVideoRecorderStartDeviceMs || chunkEndDeviceMs;
      const durationMs = Math.max(0, chunkEndDeviceMs - previousChunkEndMs);
      cameraVideoRecorderLastChunkDeviceMs = chunkEndDeviceMs;
      cameraVideoRecorderChunkIndex += 1;
      const chunkIndex = cameraVideoRecorderChunkIndex;
      const mimeType = String(blob.type || recorder.mimeType || preferredMimeType || cameraVideoRecorderMimeType || "video/webm");
      cameraVideoRecorderMimeType = mimeType;
      cameraVideoRecorderSendChain = cameraVideoRecorderSendChain.then(async () => {
        const buffer = await blob.arrayBuffer();
        sendBinaryMessage({
          type: "camera_video_chunk_header",
          device_id: runConfig.device_id,
          t_device_ms: chunkEndDeviceMs,
          duration_ms: Number(durationMs.toFixed(1)),
          chunk_index: chunkIndex,
          mime_type: mimeType,
          capture_start_device_ms: Number(cameraVideoRecorderStartDeviceMs || 0)
        }, buffer);
      }).catch(() => {});
    });

    recorder.addEventListener("error", () => {
      cameraVideoRecorderFallback = true;
      renderStatus();
      updateCameraTransport();
    });

    try {
      recorder.start(CAMERA_VIDEO_CHUNK_TIMESLICE_MS);
      cameraVideoRecorderFallback = false;
      renderStatus();
      return true;
    } catch {
      resetDirectCameraRecorderState();
      cameraVideoRecorderFallback = true;
      renderStatus();
      updateCameraTransport();
      return false;
    }
  }

  async function stopDirectCameraRecorder() {
    const recorder = cameraVideoRecorder;
    const stopPromise = cameraVideoRecorderStopPromise;
    if (!recorder) return true;
    if (recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {}
      if (stopPromise) {
        try { await stopPromise; } catch {}
      }
    }
    try { await cameraVideoRecorderSendChain; } catch {}
    resetDirectCameraRecorderState();
    renderStatus();
    return true;
  }

  async function syncDirectCameraRecorderNow() {
    if (shouldUseDirectCameraRecorder()) {
      await startDirectCameraRecorder();
      return;
    }
    await stopDirectCameraRecorder();
  }

  function syncDirectCameraRecorder() {
    cameraVideoRecorderSyncChain = cameraVideoRecorderSyncChain
      .then(() => syncDirectCameraRecorderNow())
      .catch(() => {});
    return cameraVideoRecorderSyncChain;
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
      renderDeviceIdentity();
      setJoinStatus(`Authorized for session ${joinCode} as ${authState.deviceName}`);
      persistJoinFields(deviceName, joinCode);
      wsClient?.reconnect();
      setConnectionUi(false, "Connecting...");
    } catch (err) {
      setJoinStatus(String(err?.message || "Authorization failed"), true);
    }
  }

  function normalizeJoinCode(value) {
    return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  }

  function isJoinCodeValid(value) {
    return /^[A-Z0-9]{6}$/.test(normalizeJoinCode(value));
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

  function resolveCapabilities() {
    return {
      imu: typeof DeviceMotionEvent !== "undefined",
      camera: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      audio: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      gps: !!navigator.geolocation,
      battery: !!navigator.getBattery,
      wake_lock: "wakeLock" in navigator,
      webrtc_preview: typeof RTCPeerConnection === "function",
      camera_direct_recording: canDirectRecordCameraVideo()
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
    canSendBinary() {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
      const maxBufferedBytes = this.opts.maxBufferedBytes || (1024 * 1024);
      return this.ws.bufferedAmount <= maxBufferedBytes;
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
        setJoinStatus("Motion access denied. Allow Motion & Orientation access and try again.", true);
        return;
      }
      if (motionPermissionState === "unsupported") {
        setJoinStatus("This browser is not exposing motion sensors.", true);
        return;
      }
      setJoinStatus("Motion pending");
    }, 4000);
  }

  function clearMotionWarningTimer() {
    if (!motionWarningTimer) return;
    clearTimeout(motionWarningTimer);
    motionWarningTimer = null;
  }

  function normalizeFleetOverviewPayload(msg) {
    return {
      generated_at_ms: Number(msg?.generated_at_ms || 0),
      devices: Array.isArray(msg?.devices) ? msg.devices.map((device) => ({
        device_id: String(device?.device_id || "").trim(),
        device_name: String(device?.device_name || device?.device_id || "").trim(),
        connected: device?.connected !== false,
        recording: !!device?.recording,
        motion_state: String(device?.motion_state || "").trim(),
        camera_preview_live: !!device?.camera_preview_live,
        workzone_active: !!device?.workzone_active,
        workzone_found: !!device?.workzone_found,
        workzone_tracking: !!device?.workzone_tracking,
        workzone_status: String(device?.workzone_status || "").trim(),
        workzone_fused_state: String(device?.workzone_fused_state || "OUT").trim().toUpperCase() || "OUT",
        workzone_score: Number(device?.workzone_score),
        workzone_score_threshold: Number(device?.workzone_score_threshold),
        workzone_max_confidence: Number(device?.workzone_max_confidence),
        workzone_detection_count: Math.max(0, Number(device?.workzone_detection_count || 0)),
        workzone_class_summary: String(device?.workzone_class_summary || "").trim(),
        workzone_updated_at_ms: Number(device?.workzone_updated_at_ms || 0),
        workzone_alert_latency_ms: Number(device?.workzone_alert_latency_ms),
        workzone_queue_wait_ms: Number(device?.workzone_queue_wait_ms),
        workzone_dispatch_latency_ms: Number(device?.workzone_dispatch_latency_ms),
        workzone_pipeline_latency_ms: Number(device?.workzone_pipeline_latency_ms),
        workzone_inference_ms: Number(device?.workzone_inference_ms),
        rtt_ms: Number(device?.rtt_ms),
        gps_latest: device?.gps_latest && typeof device.gps_latest === "object"
          ? {
              t_recv_ms: Number(device.gps_latest.t_recv_ms || 0),
              lat: Number(device.gps_latest.lat),
              lon: Number(device.gps_latest.lon),
              accuracy_m: Number.isFinite(Number(device.gps_latest.accuracy_m)) ? Number(device.gps_latest.accuracy_m) : -1,
              speed_mps: Number.isFinite(Number(device.gps_latest.speed_mps)) ? Number(device.gps_latest.speed_mps) : -1,
              heading_deg: Number.isFinite(Number(device.gps_latest.heading_deg)) ? Number(device.gps_latest.heading_deg) : -1
            }
          : null
      })).filter((device) => device.device_id) : []
    };
  }

  function scheduleFleetOverviewRender() {
    if (fleetOverviewRenderPending) return;
    fleetOverviewRenderPending = true;
    requestAnimationFrame(() => {
      fleetOverviewRenderPending = false;
      renderFleetOverview();
    });
  }

  function renderFleetOverview() {
    if (!phoneFleetOverviewBadge || !phoneFleetOverviewMeta || !phoneFleetOverviewStatus || !phoneFleetOverviewLegend) return;
    pruneFleetOverviewTrails(fleetOverview.devices);
    ingestFleetOverviewDevices(fleetOverview.devices);
    const tracks = buildFleetOverviewTracks();
    const connectedCount = fleetOverview.devices.filter((device) => device.connected).length;
    const liveCount = tracks.filter((track) => track.live).length;

    let badgeClass = "off";
    let badgeText = phoneFleetOverviewDetails?.open ? "Open" : "Closed";
    if (!started || !wsClient?.isConnected()) {
      badgeClass = "off";
      badgeText = "Offline";
    } else if (liveCount > 0) {
      badgeClass = "ok";
      badgeText = `${liveCount} Live`;
    } else if (connectedCount > 0) {
      badgeClass = "warn";
      badgeText = "Waiting";
    }
    phoneFleetOverviewBadge.className = `gps-badge ${badgeClass}`;
    phoneFleetOverviewBadge.textContent = badgeText;

    if (!phoneFleetOverviewDetails?.open) {
      phoneFleetOverviewMeta.textContent = !started || !wsClient?.isConnected()
        ? "Connect to the session to load the live overview."
        : `${connectedCount} phone${connectedCount === 1 ? "" : "s"} in the fleet. Open to view the map.`;
      return;
    }

    if (!phoneFleetOverviewCanvas || !phoneFleetOverviewViewport) return;
    const size = syncFleetOverviewCanvasSize();
    if (!size.width || !size.height) return;
    const ctx = phoneFleetOverviewCanvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, phoneFleetOverviewCanvas.width, phoneFleetOverviewCanvas.height);
    ctx.scale(size.dpr, size.dpr);

    const view = computeFleetOverviewView(tracks, size.width, size.height);
    drawFleetOverviewBackdrop(ctx, size.width, size.height);

    if (!started || !wsClient?.isConnected()) {
      phoneFleetOverviewStatus.hidden = false;
      phoneFleetOverviewStatus.textContent = "Connect this phone to the session to see the fleet overview.";
      phoneFleetOverviewMeta.textContent = "Fleet overview offline";
      phoneFleetOverviewLegend.innerHTML = "";
      return;
    }

    if (!tracks.length || !view) {
      phoneFleetOverviewStatus.hidden = false;
      phoneFleetOverviewStatus.textContent = connectedCount
        ? "Waiting for phones to send location fixes."
        : "No phones are connected yet.";
      phoneFleetOverviewMeta.textContent = connectedCount
        ? `${connectedCount} phone${connectedCount === 1 ? "" : "s"} connected · waiting for GPS`
        : "No live overview data yet";
      phoneFleetOverviewLegend.innerHTML = "";
      return;
    }

    const tileStats = drawFleetOverviewTiles(ctx, view, scheduleFleetOverviewRender);
    for (const track of tracks) drawFleetOverviewTrack(ctx, track, view);
    if (!tileStats.loaded && tileStats.total) {
      ctx.save();
      ctx.fillStyle = "rgba(15, 23, 40, 0.10)";
      ctx.fillRect(0, 0, size.width, size.height);
      ctx.restore();
    }
    drawFleetOverviewCrosshair(ctx, size.width, size.height);

    const totalPoints = tracks.reduce((sum, track) => sum + track.points.length, 0);
    phoneFleetOverviewMeta.textContent = `${liveCount}/${tracks.length} live · ${totalPoints} pts · ${formatFleetOverviewMetersPerPx(view.metersPerPx)} · ${tileStats.loaded}/${tileStats.total || 0} tiles`;
    renderFleetOverviewLegend(tracks);
    phoneFleetOverviewStatus.hidden = true;
  }

  function syncFleetOverviewCanvasSize() {
    const rect = phoneFleetOverviewViewport.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const nextWidth = Math.max(1, Math.round(width * dpr));
    const nextHeight = Math.max(1, Math.round(height * dpr));
    if (phoneFleetOverviewCanvas.width !== nextWidth || phoneFleetOverviewCanvas.height !== nextHeight) {
      phoneFleetOverviewCanvas.width = nextWidth;
      phoneFleetOverviewCanvas.height = nextHeight;
    }
    phoneFleetOverviewCanvas.style.width = `${width}px`;
    phoneFleetOverviewCanvas.style.height = `${height}px`;
    return { width, height, dpr };
  }

  function ingestFleetOverviewDevices(devices) {
    for (const device of Array.isArray(devices) ? devices : []) {
      if (!device?.device_id || !device.gps_latest) continue;
      ingestFleetOverviewPoint(device.device_id, device.device_name || device.device_id, device.gps_latest);
    }
  }

  function pruneFleetOverviewTrails(devices) {
    const activeIds = new Set((Array.isArray(devices) ? devices : []).map((device) => String(device?.device_id || "").trim()).filter(Boolean));
    for (const deviceId of [...fleetOverviewTrailCache.keys()]) {
      if (!activeIds.has(deviceId)) fleetOverviewTrailCache.delete(deviceId);
    }
  }

  function ingestFleetOverviewPoint(deviceId, deviceName, gpsLatest) {
    const lat = Number(gpsLatest?.lat);
    const lon = Number(gpsLatest?.lon);
    const ts = Number(gpsLatest?.t_recv_ms || 0);
    if (!isValidFleetOverviewCoordinate(lat, lon) || !ts) return;
    const entry = getOrCreateFleetOverviewTrail(deviceId, deviceName);
    entry.name = deviceName || entry.name || deviceId;
    if (entry.lastTs === ts) return;
    entry.lastTs = ts;
    entry.points.push({
      ts,
      lat,
      lon,
      accuracy_m: Number.isFinite(Number(gpsLatest?.accuracy_m)) ? Number(gpsLatest.accuracy_m) : -1,
      speed_mps: Number.isFinite(Number(gpsLatest?.speed_mps)) ? Number(gpsLatest.speed_mps) : -1,
      heading_deg: Number.isFinite(Number(gpsLatest?.heading_deg)) ? Number(gpsLatest.heading_deg) : -1
    });
    trimFleetOverviewTrail(entry.points, ts);
  }

  function getOrCreateFleetOverviewTrail(deviceId, deviceName = "") {
    const key = String(deviceId || "").trim();
    let entry = fleetOverviewTrailCache.get(key);
    if (entry) return entry;
    entry = { deviceId: key, name: deviceName || key, lastTs: 0, points: [] };
    fleetOverviewTrailCache.set(key, entry);
    return entry;
  }

  function trimFleetOverviewTrail(points, newestTs) {
    while (points.length > GPS_LIVE_TRAIL_MAX_POINTS) points.shift();
    while (points.length && newestTs - Number(points[0]?.ts || 0) > GPS_LIVE_TRAIL_MAX_AGE_MS) points.shift();
  }

  function buildFleetOverviewTracks() {
    const now = Date.now();
    const summaries = new Map((fleetOverview.devices || []).map((device) => [device.device_id, device]));
    const ids = [...new Set([...summaries.keys(), ...fleetOverviewTrailCache.keys()])];
    const tracks = [];
    for (const deviceId of ids) {
      const device = summaries.get(deviceId) || {};
      const trail = fleetOverviewTrailCache.get(deviceId);
      const points = sampleFleetOverviewPoints(trail?.points || []);
      if (!points.length) continue;
      const latest = points[points.length - 1];
      const ageMs = latest?.ts ? Math.max(0, now - Number(latest.ts)) : Number.POSITIVE_INFINITY;
      tracks.push({
        deviceId,
        name: `${device.device_name || trail?.name || deviceId}${deviceId === runConfig.device_id ? " (you)" : ""}`,
        color: fleetOverviewColorForDevice(deviceId),
        connected: device.connected !== false,
        recording: !!device.recording,
        ageMs,
        live: ageMs <= 6000,
        stale: ageMs > 6000 && ageMs <= GPS_LIVE_STALE_MS,
        points,
        latest
      });
    }
    return tracks.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }

  function sampleFleetOverviewPoints(points) {
    if (!Array.isArray(points) || !points.length) return [];
    if (points.length <= GPS_LIVE_DRAW_MAX_POINTS) return points.slice();
    const step = Math.ceil(points.length / GPS_LIVE_DRAW_MAX_POINTS);
    const sampled = [];
    for (let i = 0; i < points.length; i += step) sampled.push(points[i]);
    if (sampled[sampled.length - 1] !== points[points.length - 1]) sampled.push(points[points.length - 1]);
    return sampled;
  }

  function fleetOverviewColorForDevice(deviceId) {
    const key = String(deviceId || "");
    let hash = 0;
    for (let i = 0; i < key.length; i += 1) hash = ((hash * 31) + key.charCodeAt(i)) >>> 0;
    return GPS_LIVE_COLORS[hash % GPS_LIVE_COLORS.length];
  }

  function computeFleetOverviewView(tracks, width, height) {
    const points = tracks.flatMap((track) => track.points).filter((point) => isValidFleetOverviewCoordinate(point.lat, point.lon));
    if (!points.length || width < 40 || height < 40) return null;

    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const point of points) {
      const world = fleetOverviewLatLonToWorld(point.lat, point.lon);
      minX = Math.min(minX, world.x);
      maxX = Math.max(maxX, world.x);
      minY = Math.min(minY, world.y);
      maxY = Math.max(maxY, world.y);
    }

    const paddingPx = Math.max(28, Math.min(width, height) * 0.12);
    const usableWidth = Math.max(1, width - paddingPx * 2);
    const usableHeight = Math.max(1, height - paddingPx * 2);
    const spanX = Math.max(maxX - minX, points.length === 1 ? 0 : 1e-6);
    const spanY = Math.max(maxY - minY, points.length === 1 ? 0 : 1e-6);

    let zoom = 16;
    if (points.length > 1) {
      const zoomX = Math.log2(usableWidth / (GPS_LIVE_TILE_SIZE * Math.max(spanX, 1e-9)));
      const zoomY = Math.log2(usableHeight / (GPS_LIVE_TILE_SIZE * Math.max(spanY, 1e-9)));
      zoom = Math.floor(Math.min(zoomX, zoomY));
    }
    zoom = Math.max(2, Math.min(18, Number.isFinite(zoom) ? zoom : 16));

    const scale = GPS_LIVE_TILE_SIZE * (2 ** zoom);
    const centerWorldX = (minX + maxX) / 2;
    const centerWorldY = (minY + maxY) / 2;
    const centerPxX = centerWorldX * scale;
    const centerPxY = centerWorldY * scale;
    const centerLat = points[Math.floor(points.length / 2)]?.lat ?? tracks[0]?.latest?.lat ?? 0;
    const metersPerPx = 156543.03392 * Math.cos((centerLat * Math.PI) / 180) / (2 ** zoom);

    return {
      width,
      height,
      zoom,
      scale,
      centerPxX,
      centerPxY,
      metersPerPx,
      project(lat, lon) {
        const world = fleetOverviewLatLonToWorld(lat, lon);
        return {
          x: (world.x * scale) - centerPxX + (width / 2),
          y: (world.y * scale) - centerPxY + (height / 2)
        };
      }
    };
  }

  function fleetOverviewLatLonToWorld(lat, lon) {
    const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, Number(lat || 0)));
    const normalizedLon = Math.max(-180, Math.min(180, Number(lon || 0)));
    const x = (normalizedLon + 180) / 360;
    const sin = Math.sin((clampedLat * Math.PI) / 180);
    const y = 0.5 - (Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI));
    return { x, y };
  }

  function drawFleetOverviewBackdrop(ctx, width, height) {
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, "#0d1527");
    gradient.addColorStop(1, "#12203b");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
    ctx.lineWidth = 1;
    const step = 44;
    for (let x = 0; x <= width; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 0; y <= height; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawFleetOverviewTiles(ctx, view, onInvalidate) {
    const tileSpan = 2 ** view.zoom;
    const left = view.centerPxX - (view.width / 2);
    const top = view.centerPxY - (view.height / 2);
    const startTileX = Math.floor(left / GPS_LIVE_TILE_SIZE);
    const endTileX = Math.floor((left + view.width) / GPS_LIVE_TILE_SIZE);
    const startTileY = Math.floor(top / GPS_LIVE_TILE_SIZE);
    const endTileY = Math.floor((top + view.height) / GPS_LIVE_TILE_SIZE);
    let total = 0;
    let loaded = 0;

    for (let rawTileX = startTileX; rawTileX <= endTileX; rawTileX += 1) {
      for (let rawTileY = startTileY; rawTileY <= endTileY; rawTileY += 1) {
        if (rawTileY < 0 || rawTileY >= tileSpan) continue;
        total += 1;
        const wrappedTileX = ((rawTileX % tileSpan) + tileSpan) % tileSpan;
        const tile = ensureFleetOverviewTile(view.zoom, wrappedTileX, rawTileY, onInvalidate);
        const dx = Math.round((rawTileX * GPS_LIVE_TILE_SIZE) - left);
        const dy = Math.round((rawTileY * GPS_LIVE_TILE_SIZE) - top);

        if (tile?.status === "loaded" && tile.image?.complete) {
          ctx.drawImage(tile.image, dx, dy, GPS_LIVE_TILE_SIZE, GPS_LIVE_TILE_SIZE);
          loaded += 1;
        } else {
          ctx.save();
          ctx.fillStyle = tile?.status === "error" ? "rgba(120, 17, 34, 0.14)" : "rgba(255, 255, 255, 0.03)";
          ctx.fillRect(dx, dy, GPS_LIVE_TILE_SIZE, GPS_LIVE_TILE_SIZE);
          ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
          ctx.strokeRect(dx, dy, GPS_LIVE_TILE_SIZE, GPS_LIVE_TILE_SIZE);
          ctx.restore();
        }
      }
    }

    return { total, loaded };
  }

  function ensureFleetOverviewTile(z, x, y, onInvalidate) {
    const key = `${z}/${x}/${y}`;
    let entry = fleetOverviewTileCache.get(key);
    if (entry) return entry;
    const image = new Image();
    entry = { status: "loading", image };
    fleetOverviewTileCache.set(key, entry);
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => {
      entry.status = "loaded";
      onInvalidate?.();
    };
    image.onerror = () => {
      entry.status = "error";
      onInvalidate?.();
    };
    image.src = GPS_LIVE_TILE_TEMPLATE
      .replace("{z}", String(z))
      .replace("{x}", String(x))
      .replace("{y}", String(y));
    return entry;
  }

  function drawFleetOverviewTrack(ctx, track, view) {
    if (!track?.points?.length) return;
    const projected = track.points.map((point) => ({
      ...view.project(point.lat, point.lon),
      accuracy_m: point.accuracy_m
    }));
    if (!projected.length) return;

    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    ctx.strokeStyle = "rgba(9, 12, 20, 0.80)";
    ctx.lineWidth = 6;
    ctx.beginPath();
    for (let i = 0; i < projected.length; i += 1) {
      const point = projected[i];
      if (i === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    }
    ctx.stroke();

    ctx.strokeStyle = track.color;
    ctx.lineWidth = track.live ? 3 : 2.5;
    ctx.globalAlpha = track.live ? 0.95 : 0.68;
    ctx.beginPath();
    for (let i = 0; i < projected.length; i += 1) {
      const point = projected[i];
      if (i === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    const last = projected[projected.length - 1];
    const accuracyRadius = Number.isFinite(last.accuracy_m) && last.accuracy_m > 0
      ? Math.max(8, Math.min(80, last.accuracy_m / Math.max(0.5, view.metersPerPx)))
      : 0;
    if (accuracyRadius > 0) {
      ctx.fillStyle = `${track.color}22`;
      ctx.beginPath();
      ctx.arc(last.x, last.y, accuracyRadius, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = track.color;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(last.x, last.y, track.deviceId === runConfig.device_id ? 7 : 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function drawFleetOverviewCrosshair(ctx, width, height) {
    ctx.save();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo((width / 2) - 8, height / 2);
    ctx.lineTo((width / 2) + 8, height / 2);
    ctx.moveTo(width / 2, (height / 2) - 8);
    ctx.lineTo(width / 2, (height / 2) + 8);
    ctx.stroke();
    ctx.restore();
  }

  function renderFleetOverviewLegend(tracks) {
    phoneFleetOverviewLegend.innerHTML = "";
    for (const track of tracks) {
      const item = document.createElement("div");
      item.className = `gps-live-chip ${track.live ? "is-live" : track.stale ? "is-stale" : "is-old"}`;
      const swatch = document.createElement("span");
      swatch.className = "gps-live-chip-swatch";
      swatch.style.background = track.color;
      const text = document.createElement("span");
      text.textContent = `${track.name} · ${track.latest?.lat?.toFixed?.(5) || "-"}, ${track.latest?.lon?.toFixed?.(5) || "-"}`;
      item.append(swatch, text);
      phoneFleetOverviewLegend.appendChild(item);
    }
  }

  function formatFleetOverviewMetersPerPx(metersPerPx) {
    const value = Math.max(0, Number(metersPerPx || 0));
    if (!value) return "scale --";
    if (value >= 1000) return `${(value / 1000).toFixed(2)} km/px`;
    if (value >= 100) return `${Math.round(value)} m/px`;
    return `${value.toFixed(1)} m/px`;
  }

  function isValidFleetOverviewCoordinate(lat, lon) {
    return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
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

  function readinessItem(label, state, detail) {
    return { label, state: String(state || "warning"), detail: String(detail || "waiting") };
  }

  function ageFresh(ts, now, maxAgeMs) {
    return Number(ts || 0) > 0 && (now - Number(ts || 0)) <= maxAgeMs;
  }
})();
