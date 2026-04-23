import { createStore, createEventBus, clamp, clone, formatElapsed, escapeHtml } from "./store.js";
import { ACTIVE_LAYOUT_KEY, defaultLayouts, loadLayouts, normalizeLayout, persistLayouts } from "./layouts.js";
import { createWidgetRegistry, getWidgetDevice } from "./widgets.js";

const DEFAULT_RUN_CONFIG = {
  device_id: "phone1",
  streams: {
    imu: { enabled: true, rate_hz: 30, record: true },
    camera: { mode: "off", fps: 10, jpeg_q: 0.6, record: false, record_mode: "both", encode_timing: "post_session", video_fps: 30, video_bitrate: "2M", video_crf: 23, downsample_factor: 1 },
    gps: { enabled: false, rate_hz: 1, record: false },
    audio: { enabled: false, rate_hz: 10, record: false },
    device: { enabled: true, rate_hz: 1, record: false },
    fusion: { enabled: true, record: false },
    events: { enabled: true, record: true },
    net: { enabled: true, record: true }
  }
};

const els = {
  logoutBtn: document.getElementById("logoutBtn"),
  statusSystem: document.getElementById("statusSystem"),
  statusConn: document.getElementById("statusConn"),
  statusRec: document.getElementById("statusRec"),
  statusDevices: document.getElementById("statusDevices"),
  advancedLayoutPanel: document.getElementById("advancedLayoutPanel"),
  layoutSelect: document.getElementById("layoutSelect"),
  layoutPresetSelect: document.getElementById("layoutPresetSelect"),
  editLayoutBtn: document.getElementById("editLayoutBtn"),
  layoutNameInput: document.getElementById("layoutNameInput"),
  saveLayoutBtn: document.getElementById("saveLayoutBtn"),
  deleteLayoutBtn: document.getElementById("deleteLayoutBtn"),
  exportLayoutBtn: document.getElementById("exportLayoutBtn"),
  importLayoutFile: document.getElementById("importLayoutFile"),
  addWidgetSelect: document.getElementById("addWidgetSelect"),
  addWidgetBtn: document.getElementById("addWidgetBtn"),
  editToolsRow: document.getElementById("editToolsRow"),
  widgetGrid: document.getElementById("widgetGrid")
};

let ws = null;
let dragSession = null;
let snapOverlayEl = null;
let dashboardResizeRaf = null;
let dashboardGridColumnCount = 12;
const mountedWidgets = new Map();

const store = createStore({
  wsConnected: false,
  deviceList: [],
  statesByDevice: {},
  runConfigsByDevice: {},
  sessionConfig: clone(DEFAULT_RUN_CONFIG),
  sessionJoinCode: "",
  sessionState: "draft",
  recording: { active: false, phase: "IDLE", mode: "all", session_id: null, session_dir: null, started_at_utc_ms: null, elapsed_sec: 0, devices_recording: 0, devices_online: 0 },
  runtime: {
    server_started_at_ms: null,
    server_uptime_sec: 0,
    public_started_at_ms: null,
    public_uptime_sec: null,
    public_url: null,
    public_mode: null,
    workzone_live: null
  },
  recordByDevice: {},
  replaySessions: [],
  storage: { sessions_size_gb: 0, session_count: 0, free_disk_bytes: null },
  editMode: false,
  focusWidgetId: null,
  layouts: {},
  activeLayoutName: "Overview"
});

const bus = createEventBus();
const previewRtc = createPreviewRtcManager({ bus, sendJson });
const widgetRegistry = createWidgetRegistry({
  store,
  bus,
  previewRtc,
  sendJson,
  mergeRunConfig,
  defaultRunConfig: DEFAULT_RUN_CONFIG,
  loadReplaySessions
});

init();

function init() {
  const makeWidget = (type, overrides = {}) => {
    const def = widgetRegistry[type];
    return {
      id: `w_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type,
      w: overrides.w ?? def.defaults.w,
      h: overrides.h ?? def.defaults.h,
      pinned: overrides.pinned ?? !!def.defaults.pinned,
      settings: { ...clone(def.defaults.settings || {}), ...(overrides.settings || {}) }
    };
  };

  const layouts = loadLayouts(() => defaultLayouts(makeWidget));
  const active = localStorage.getItem(ACTIVE_LAYOUT_KEY) || "Overview";
  store.setState({
    layouts,
    activeLayoutName: layouts[active] ? active : Object.keys(layouts)[0] || "Overview"
  });

  bindTopUi();
  bindResponsiveDashboard();
  document.body.setAttribute("data-theme", "dark");
  renderWidgetTypeOptions();
  renderLayoutSelectors();
  renderDashboard();
  connectWs();
  loadReplaySessions();
  loadStorageHealth();
  setInterval(loadStorageHealth, 5000);

  store.subscribe(
    (s) => ({
      ws: s.wsConnected,
      rec: s.recording,
      list: s.deviceList,
      states: s.statesByDevice
    }),
    () => {
      updateGlobalStatusBar();
    }
  );

  store.subscribe((s) => ({ edit: s.editMode, active: s.activeLayoutName, layouts: s.layouts }), () => {
    renderLayoutSelectors();
    els.editToolsRow.style.display = store.getState().editMode ? "flex" : "none";
    els.editLayoutBtn.textContent = store.getState().editMode ? "Done Editing" : "Edit Layout";
  });

  updateGlobalStatusBar();

  bus.on("preview_image", (src) => {
    const cameraWidget = [...mountedWidgets.values()].find((m) => m.type === "camera_preview");
    const img = cameraWidget?.el.querySelector("img");
    if (img) img.src = src;
  });
}

function createPreviewRtcManager({ bus, sendJson }) {
  const ICE_SERVERS = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
  const entries = new Map();
  let signalingConnected = false;
  let dashboardClientId = "";

  function ensureEntry(deviceId) {
    const key = String(deviceId || "").trim();
    if (!key) return null;
    if (entries.has(key)) return entries.get(key);
    const entry = {
      deviceId: key,
      available: { connected: false, previewEnabled: false },
      sinks: new Set(),
      pc: null,
      stream: null,
      pendingRemoteIce: [],
      restartTimer: null,
      connecting: false,
      live: false,
      error: ""
    };
    entries.set(key, entry);
    return entry;
  }

  function isDesired(entry) {
    return !!entry && signalingConnected && !!dashboardClientId && entry.available.connected && entry.available.previewEnabled && entry.sinks.size > 0;
  }

  function applyStream(entry) {
    const stream = entry?.stream && entry.stream.getTracks().length ? entry.stream : null;
    for (const sink of entry?.sinks || []) {
      if (sink.srcObject !== stream) sink.srcObject = stream;
      if (stream) {
        try { sink.play?.().catch(() => {}); } catch {}
      }
    }
  }

  function emitUpdate(deviceId) {
    bus.emit("preview_rtc_update", { deviceId });
  }

  function clearRestart(entry) {
    if (!entry?.restartTimer) return;
    clearTimeout(entry.restartTimer);
    entry.restartTimer = null;
  }

  function humanizeReason(reason) {
    if (reason === "camera_disabled") return "Camera disabled";
    if (reason === "camera_unavailable") return "Camera unavailable";
    if (reason === "dashboard_disconnected") return "Dashboard reconnecting";
    if (reason === "preview_failed") return "Preview reconnecting";
    if (reason === "answer_failed") return "Preview negotiation failed";
    return reason ? String(reason).replaceAll("_", " ") : "";
  }

  function cleanupEntry(entry) {
    if (!entry || entry.sinks.size || entry.pc || entry.restartTimer || entry.available.connected || entry.available.previewEnabled) return;
    entries.delete(entry.deviceId);
  }

  function stopPeer(entry, notifyPhone = false, reason = "preview_closed") {
    if (!entry) return;
    clearRestart(entry);
    const hadPeer = !!entry.pc;
    entry.connecting = false;
    entry.live = false;
    entry.pendingRemoteIce = [];
    entry.stream = null;
    if (notifyPhone && signalingConnected && dashboardClientId && hadPeer) {
      sendJson({
        type: "webrtc_signal",
        device_id: entry.deviceId,
        dashboard_id: dashboardClientId,
        signal: { type: "disconnect", reason }
      });
    }
    if (entry.pc) {
      try {
        entry.pc.ontrack = null;
        entry.pc.onicecandidate = null;
        entry.pc.onconnectionstatechange = null;
        entry.pc.oniceconnectionstatechange = null;
        entry.pc.close();
      } catch {}
    }
    entry.pc = null;
    applyStream(entry);
    emitUpdate(entry.deviceId);
    cleanupEntry(entry);
  }

  function scheduleReconnect(entry, delayMs = 1500) {
    if (!entry || entry.restartTimer || !isDesired(entry)) return;
    entry.restartTimer = setTimeout(() => {
      entry.restartTimer = null;
      maybeStart(entry);
    }, delayMs);
  }

  async function flushPendingIce(entry) {
    if (!entry?.pc || !entry.pendingRemoteIce.length) return;
    while (entry.pendingRemoteIce.length) {
      const candidate = entry.pendingRemoteIce.shift();
      try {
        await entry.pc.addIceCandidate(candidate);
      } catch {}
    }
  }

  async function maybeStart(entry) {
    if (!isDesired(entry) || entry.pc || entry.connecting) return;
    entry.connecting = true;
    entry.error = "";
    emitUpdate(entry.deviceId);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    entry.pc = pc;
    entry.stream = null;
    entry.pendingRemoteIce = [];
    applyStream(entry);

    const handlePeerFailure = (reason) => {
      if (entry.pc !== pc) return;
      entry.error = humanizeReason(reason) || "Preview reconnecting";
      stopPeer(entry, false);
      scheduleReconnect(entry);
    };

    const syncTransportState = () => {
      if (entry.pc !== pc) return;
      const states = [String(pc.connectionState || ""), String(pc.iceConnectionState || "")];
      const live = states.includes("connected") || states.includes("completed");
      if (entry.live !== live) {
        entry.live = live;
        emitUpdate(entry.deviceId);
      }
      if (states.includes("failed") || states.includes("closed")) {
        handlePeerFailure("preview_failed");
        return;
      }
      if (states.includes("disconnected")) {
        entry.live = false;
        emitUpdate(entry.deviceId);
        handlePeerFailure("preview_failed");
      }
    };

    pc.addTransceiver("video", { direction: "recvonly" });
    pc.ontrack = (ev) => {
      if (entry.pc !== pc) return;
      entry.stream = ev.streams?.[0] || new MediaStream([ev.track]);
      entry.live = true;
      entry.error = "";
      applyStream(entry);
      emitUpdate(entry.deviceId);
      ev.track.onended = () => {
        if (entry.pc !== pc) return;
        entry.live = false;
        emitUpdate(entry.deviceId);
      };
    };
    pc.onicecandidate = (ev) => {
      if (!ev.candidate || entry.pc !== pc || !signalingConnected || !dashboardClientId) return;
      sendJson({
        type: "webrtc_signal",
        device_id: entry.deviceId,
        dashboard_id: dashboardClientId,
        signal: {
          type: "ice",
          candidate: ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate
        }
      });
    };
    pc.onconnectionstatechange = syncTransportState;
    pc.oniceconnectionstatechange = syncTransportState;

    try {
      const offer = await pc.createOffer();
      if (entry.pc !== pc) return;
      await pc.setLocalDescription(offer);
      if (entry.pc !== pc || !signalingConnected || !dashboardClientId) return;
      sendJson({
        type: "webrtc_signal",
        device_id: entry.deviceId,
        dashboard_id: dashboardClientId,
        signal: { type: "offer", sdp: String(pc.localDescription?.sdp || offer.sdp || "") }
      });
    } catch {
      entry.error = "Live preview failed to start";
      stopPeer(entry, false);
      scheduleReconnect(entry, 2000);
    } finally {
      entry.connecting = false;
      emitUpdate(entry.deviceId);
    }
  }

  function setSignalingState({ connected, clientId } = {}) {
    const nextConnected = typeof connected === "boolean" ? connected : signalingConnected;
    const nextClientId = typeof clientId === "string" ? clientId : dashboardClientId;
    const clientChanged = nextClientId !== dashboardClientId;
    const connectionChanged = nextConnected !== signalingConnected;

    signalingConnected = nextConnected;
    dashboardClientId = nextClientId;

    if (clientChanged || !signalingConnected) {
      for (const entry of entries.values()) {
        stopPeer(entry, false);
      }
      if (signalingConnected) {
        for (const entry of entries.values()) maybeStart(entry);
      }
    } else if (connectionChanged && signalingConnected) {
      for (const entry of entries.values()) {
        maybeStart(entry);
      }
    }
  }

  async function handleSignal(msg) {
    const deviceId = String(msg.device_id || "").trim();
    const signal = msg.signal && typeof msg.signal === "object" ? msg.signal : null;
    if (!deviceId || !signal) return;
    const entry = ensureEntry(deviceId);
    if (!entry) return;

    if (signal.type === "answer") {
      if (!entry.pc || typeof signal.sdp !== "string") return;
      try {
        await entry.pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
        entry.error = "";
        await flushPendingIce(entry);
        emitUpdate(entry.deviceId);
      } catch {
        entry.error = "Preview negotiation failed";
        stopPeer(entry, false);
        scheduleReconnect(entry, 2000);
      }
      return;
    }

    if (signal.type === "ice") {
      if (!entry.pc || !signal.candidate) return;
      if (!entry.pc.remoteDescription) {
        entry.pendingRemoteIce.push(signal.candidate);
        return;
      }
      try {
        await entry.pc.addIceCandidate(signal.candidate);
      } catch {}
      return;
    }

    if (signal.type === "disconnect" || signal.type === "unavailable") {
      entry.error = humanizeReason(signal.reason || signal.type);
      stopPeer(entry, false);
      if (signal.type === "unavailable") scheduleReconnect(entry, 3000);
    }
  }

  function registerSink(deviceId, videoEl) {
    const entry = ensureEntry(deviceId);
    if (!entry || !videoEl) return () => {};
    videoEl.autoplay = true;
    videoEl.muted = true;
    videoEl.playsInline = true;
    entry.sinks.add(videoEl);
    applyStream(entry);
    maybeStart(entry);
    emitUpdate(entry.deviceId);
    return () => {
      entry.sinks.delete(videoEl);
      videoEl.srcObject = null;
      if (!entry.sinks.size) stopPeer(entry, true, "widget_closed");
      cleanupEntry(entry);
    };
  }

  function updateAvailability(deviceId, availability = {}) {
    const entry = ensureEntry(deviceId);
    if (!entry) return;
    const nextConnected = !!availability.connected;
    const nextPreviewEnabled = !!availability.previewEnabled;
    if (entry.available.connected === nextConnected && entry.available.previewEnabled === nextPreviewEnabled) return;
    entry.available = {
      connected: nextConnected,
      previewEnabled: nextPreviewEnabled
    };
    if (!entry.available.connected || !entry.available.previewEnabled) {
      stopPeer(entry, true, "preview_unavailable");
      if (!entry.available.connected || !entry.available.previewEnabled) entry.error = "";
    } else {
      maybeStart(entry);
    }
    emitUpdate(entry.deviceId);
  }

  function getState(deviceId) {
    const entry = entries.get(String(deviceId || "").trim());
    return {
      live: !!entry?.live,
      connecting: !!entry?.pc || !!entry?.connecting,
      error: entry?.error || "",
      stream: entry?.stream || null
    };
  }

  return {
    getState,
    handleSignal,
    registerSink,
    setSignalingState,
    updateAvailability
  };
}

function updateGlobalStatusBar() {
  const st = store.getState();
  const totalCount = (st.deviceList || []).length;
  const onlineCount = (st.deviceList || []).filter((d) => d?.connected !== false).length;
  const systemReady = st.wsConnected && onlineCount > 0;
  const phoneLabel = `${onlineCount} phone${onlineCount === 1 ? "" : "s"} online`;
  const fleetText = systemReady
    ? "Ready to record"
    : (st.wsConnected ? "Waiting for phones" : "Connecting to server");
  setHeaderStatus(els.statusSystem, fleetText, systemReady ? "green" : "gray");
  setHeaderStatus(els.statusConn, st.wsConnected ? "Dashboard connected" : "Dashboard offline", st.wsConnected ? "green" : "gray");
  setHeaderStatus(els.statusDevices, totalCount > onlineCount ? `${phoneLabel} of ${totalCount}` : phoneLabel);
  setHeaderStatus(
    els.statusRec,
    st.recording?.active ? `Recording ${formatElapsed(st.recording.elapsed_sec || 0)}` : "Not recording",
    st.recording?.active ? "red" : "gray"
  );
}

function bindResponsiveDashboard() {
  window.addEventListener("resize", () => {
    if (dashboardResizeRaf) return;
    dashboardResizeRaf = requestAnimationFrame(() => {
      dashboardResizeRaf = null;
      const nextColumnCount = getWidgetGridColumnCount();
      if (nextColumnCount === dashboardGridColumnCount) return;
      renderDashboard();
    });
  });
}

function getWidgetGridColumnCount() {
  if (window.matchMedia("(max-width: 768px)").matches) return 2;
  if (window.matchMedia("(max-width: 980px)").matches) return 6;
  return 12;
}

function setHeaderStatus(el, value, tone = null) {
  if (!el) return;
  const textEl = el.querySelector(".status-text");
  const dotEl = el.querySelector(".indicator");
  if (textEl) textEl.textContent = value;
  if (dotEl) {
    dotEl.hidden = !tone;
    dotEl.classList.remove("green", "gray", "red");
    if (tone) dotEl.classList.add(tone);
  }
}

function widgetModality(widgetType) {
  if (widgetType === "imu_plot") return "imu";
  if (widgetType === "camera_preview") return "cam";
  if (widgetType === "audio_live") return "audio";
  if (widgetType === "gps_live") return "gps";
  return null;
}

function normalizeRecordPhase(value, isRecording = false) {
  const phase = String(value || "").toLowerCase();
  if (phase === "starting" || phase === "recording" || phase === "stopping") return phase;
  return isRecording ? "recording" : "idle";
}

function widgetModalityRecordsToDisk(deviceId, modality) {
  const st = store.getState();
  const cfg = st.runConfigsByDevice?.[deviceId] || st.sessionConfig || DEFAULT_RUN_CONFIG;
  if (modality === "imu") return !!cfg?.streams?.imu?.record;
  if (modality === "cam") return !!cfg?.streams?.camera?.record && cfg?.streams?.camera?.mode === "stream";
  if (modality === "audio") return !!cfg?.streams?.audio?.record;
  if (modality === "gps") return !!cfg?.streams?.gps?.record;
  return false;
}

function panelRecBadgeHtml(instance) {
  const modality = widgetModality(instance.type);
  if (!modality) return "";
  const st = store.getState();
  const deviceId = getWidgetDevice(instance.settings);
  const rec = st.recordByDevice?.[deviceId];
  if (!rec || rec.connected === false) return "";
  const phase = normalizeRecordPhase(rec.phase, rec.recording);
  const shouldRecord = widgetModalityRecordsToDisk(deviceId, modality);
  if (!shouldRecord) return "";
  if (phase === "starting") {
    return ' <span class="panel-rec rec-pending" title="Waiting for the first confirmed write">Starting</span>';
  }
  if (phase === "stopping") {
    return ' <span class="panel-rec rec-stopping" title="Finalizing recording on disk">Stopping</span>';
  }
  const on = phase === "recording" && !!rec?.modalities?.[modality];
  return on
    ? ' <span class="panel-rec rec-on" title="Recording to disk">Recording</span>'
    : "";
}
function bindTopUi() {
  els.editLayoutBtn.addEventListener("click", () => {
    const nextEditMode = !store.getState().editMode;
    store.setState({ editMode: nextEditMode });
    if (els.advancedLayoutPanel) els.advancedLayoutPanel.open = nextEditMode;
    renderDashboard();
  });
  els.layoutSelect.addEventListener("change", () => {
    const name = els.layoutSelect.value;
    if (!name) return;
    setActiveLayout(name);
    renderDashboard();
  });

  els.layoutPresetSelect.addEventListener("change", () => {
    const name = els.layoutPresetSelect.value;
    if (!name) return;
    applyLayoutPreset(name);
    els.layoutPresetSelect.value = "";
  });

  els.saveLayoutBtn.addEventListener("click", () => {
    const raw = (els.layoutNameInput.value || "").trim();
    if (!raw) return;
    const st = store.getState();
    const current = clone(st.layouts[st.activeLayoutName]);
    current.name = raw;
    const layouts = { ...st.layouts, [raw]: current };
    store.setState({ layouts, activeLayoutName: raw });
    persistLayouts(layouts, raw);
    renderDashboard();
    els.layoutNameInput.value = "";
  });

  els.deleteLayoutBtn.addEventListener("click", () => {
    const st = store.getState();
    const layouts = { ...st.layouts };
    delete layouts[st.activeLayoutName];
    if (!Object.keys(layouts).length) return;
    const next = Object.keys(layouts)[0];
    store.setState({ layouts, activeLayoutName: next, focusWidgetId: null });
    persistLayouts(layouts, next);
    renderDashboard();
  });

  els.exportLayoutBtn.addEventListener("click", () => {
    const st = store.getState();
    const layout = st.layouts[st.activeLayoutName];
    if (!layout) return;
    const blob = new Blob([JSON.stringify(layout, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${layout.name}.json`;
    a.click();
  });

  els.importLayoutFile.addEventListener("change", async () => {
    const file = els.importLayoutFile.files?.[0];
    if (!file) return;
    try {
      const layout = JSON.parse(await file.text());
      if (!layout?.name || !Array.isArray(layout.widgets)) return;
      const st = store.getState();
      const layouts = { ...st.layouts, [layout.name]: normalizeLayout(layout, widgetRegistry) };
      store.setState({ layouts, activeLayoutName: layout.name });
      persistLayouts(layouts, layout.name);
      renderDashboard();
    } finally {
      els.importLayoutFile.value = "";
    }
  });

  els.addWidgetBtn.addEventListener("click", () => {
    const type = els.addWidgetSelect.value;
    if (!type || !widgetRegistry[type]) return;
    mutateLayout((layout) => {
      const def = widgetRegistry[type];
      layout.widgets.push({
        id: `w_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type,
        w: def.defaults.w,
        h: def.defaults.h,
        pinned: !!def.defaults.pinned,
        settings: clone(def.defaults.settings || {})
      });
    });
    renderDashboard();
  });

  els.logoutBtn?.addEventListener("click", async () => {
    try {
      await fetch("/api/dashboard/logout", { method: "POST" });
    } catch {}
    window.location.assign("/dashboard/login");
  });
}

function connectWs() {
  const wsScheme = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${wsScheme}://${location.host}/ws`);
  ws.onopen = () => {
    store.setState({ wsConnected: true });
    previewRtc.setSignalingState({ connected: true });
    sendJson({ type: "hello", role: "dashboard" });
  };
  ws.onclose = () => {
    store.setState({ wsConnected: false });
    previewRtc.setSignalingState({ connected: false, clientId: "" });
    setTimeout(connectWs, 1000);
  };
  ws.onmessage = (ev) => {
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg) return;

    if (msg.type === "hello_ack" && msg.role === "dashboard") {
      previewRtc.setSignalingState({ connected: true, clientId: String(msg.client_id || "") });
      return;
    }

    if (msg.type === "auth_required") {
      window.location.assign(`/dashboard/login?next=${encodeURIComponent(location.pathname + location.search)}`);
      return;
    }

    if (msg.type === "webrtc_signal") {
      void previewRtc.handleSignal(msg);
      return;
    }

    if (msg.type === "device_list") {
      const st = store.getState();
      const nextList = Array.isArray(msg.devices) ? msg.devices : [];
      const nextStates = { ...st.statesByDevice };
      for (const d of nextList) {
        if (!nextStates[d.device_id]) nextStates[d.device_id] = { connected: !!d.connected };
      }
      store.setState({ deviceList: nextList, statesByDevice: nextStates });
      return;
    }

    if (msg.type === "config") {
      const id = msg.device_id || null;
      const st = store.getState();
      const merged = mergeRunConfig(msg.runConfig || {});
      if (!id) {
        store.setState({ sessionConfig: merged });
      } else {
        store.setState({ runConfigsByDevice: { ...st.runConfigsByDevice, [id]: merged }, sessionConfig: merged });
      }
      return;
    }

    if (msg.type === "session_config") {
      const st = store.getState();
      store.setState({
        sessionConfig: mergeRunConfig(msg.sessionConfig || st.sessionConfig || DEFAULT_RUN_CONFIG),
        sessionJoinCode: String(msg.joinCode || st.sessionJoinCode || ""),
        sessionState: msg.sessionState || (st.recording?.active ? "active" : "draft")
      });
      return;
    }

    if (msg.type === "record_status") {
      const id = msg.device_id;
      if (!id) return;
      const st = store.getState();
      store.setState({
        recordByDevice: {
          ...st.recordByDevice,
          [id]: {
            ...(st.recordByDevice[id] || {}),
            device_id: id,
            connected: msg.connected !== false,
            recording: !!msg.recording,
            phase: normalizeRecordPhase(msg.phase, !!msg.recording),
            session_id: msg.session_id || null,
            started_at_utc_ms: msg.started_at_utc_ms || null,
            acknowledged_at_utc_ms: msg.acknowledged_at_utc_ms || null,
            modalities: msg.modalities || { imu: false, cam: false, audio: false, gps: false },
            writer: msg.writer || { last_write_utc_ms: null, dropped: 0 }
          }
        }
      });
      return;
    }

    if (msg.type === "record_stopped") {
      const id = msg.device_id;
      if (!id) return;
      const st = store.getState();
      const prev = st.recordByDevice[id] || {};
      store.setState({
        recordByDevice: {
          ...st.recordByDevice,
          [id]: {
            ...prev,
            connected: prev.connected !== false,
            recording: false,
            phase: "idle",
            acknowledged_at_utc_ms: null,
            modalities: { imu: false, cam: false, audio: false, gps: false },
            files: msg.files || prev.files || {}
          }
        }
      });
      return;
    }

    if (msg.type === "state") {
      const st = store.getState();
      const byDevice = { ...st.statesByDevice };
      if (msg.device_states && typeof msg.device_states === "object") {
        for (const [id, state] of Object.entries(msg.device_states)) byDevice[id] = state;
      }
      store.setState({
        deviceList: Array.isArray(msg.devices) ? msg.devices : st.deviceList,
        statesByDevice: byDevice,
        recording: msg.recording || st.recording,
        runtime: msg.runtime || st.runtime,
        sessionConfig: mergeRunConfig(msg.sessionConfig || st.sessionConfig || DEFAULT_RUN_CONFIG),
        sessionState: msg.sessionState || ((msg.recording || st.recording).active ? "active" : "draft")
      });
      return;
    }
  };
}
function mutateLayout(mutator) {
  const st = store.getState();
  const layout = clone(st.layouts[st.activeLayoutName]);
  if (!layout) return;
  mutator(layout);
  const normalized = normalizeLayout(layout, widgetRegistry);
  const layouts = { ...st.layouts, [normalized.name]: normalized };
  store.setState({ layouts });
  persistLayouts(layouts, st.activeLayoutName);
}

function getActiveLayout() {
  const st = store.getState();
  return normalizeLayout(st.layouts[st.activeLayoutName], widgetRegistry);
}

function setActiveLayout(name) {
  const st = store.getState();
  if (!st.layouts[name]) return;
  store.setState({ activeLayoutName: name, focusWidgetId: null });
  persistLayouts(st.layouts, name);
}

function applyLayoutPreset(name) {
  const makeWidget = (type, overrides = {}) => {
    const def = widgetRegistry[type];
    return { id: `w_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, type, w: overrides.w ?? def.defaults.w, h: overrides.h ?? def.defaults.h, pinned: overrides.pinned ?? !!def.defaults.pinned, settings: { ...clone(def.defaults.settings || {}), ...(overrides.settings || {}) } };
  };
  const presets = defaultLayouts(makeWidget);
  if (!presets[name]) return;
  const st = store.getState();
  const layouts = { ...st.layouts, [name]: normalizeLayout(presets[name], widgetRegistry) };
  store.setState({ layouts, activeLayoutName: name, focusWidgetId: null });
  persistLayouts(layouts, name);
  renderDashboard();
}

function renderWidgetTypeOptions() {
  els.addWidgetSelect.innerHTML = "";
  for (const [type, def] of Object.entries(widgetRegistry)) {
    const opt = document.createElement("option");
    opt.value = type;
    opt.textContent = def.title;
    els.addWidgetSelect.appendChild(opt);
  }
}

function renderLayoutSelectors() {
  const st = store.getState();
  els.layoutSelect.innerHTML = "";
  for (const n of Object.keys(st.layouts)) {
    const opt = document.createElement("option");
    opt.value = n;
    opt.textContent = n;
    els.layoutSelect.appendChild(opt);
  }
  if (st.layouts[st.activeLayoutName]) els.layoutSelect.value = st.activeLayoutName;
  els.layoutNameInput.placeholder = st.activeLayoutName ? `e.g. ${st.activeLayoutName} Copy` : "e.g. Demo";
}


function renderDeviceFilter() {
  return;
}

function renderDashboard() {
  for (const m of mountedWidgets.values()) for (const c of m.cleanups) c();
  mountedWidgets.clear();
  els.widgetGrid.innerHTML = "";
  dragSession = null;

  snapOverlayEl = document.createElement("div");
  snapOverlayEl.className = "grid-snap-overlay";
  els.widgetGrid.appendChild(snapOverlayEl);
  dashboardGridColumnCount = getWidgetGridColumnCount();

  const st = store.getState();
  const layout = getActiveLayout();
  if (!layout) return;
  const ordered = [...layout.widgets].sort((a, b) => Number(b.pinned) - Number(a.pinned));
  const visible = st.focusWidgetId ? ordered.filter((w) => w.id === st.focusWidgetId || w.pinned) : ordered;
  els.widgetGrid.classList.toggle("focus-mode", !!st.focusWidgetId);
  els.widgetGrid.classList.toggle("grid-editing", !!st.editMode);

  for (const instance of visible) {
    const def = widgetRegistry[instance.type];
    if (!def) continue;
    const hasVisibleSettings = widgetHasVisibleSettings(def.settingsSchema);

    const card = document.createElement("article");
    card.className = "card widget-card";
    const controlTypes = new Set(["stream_controls", "events_timeline", "replay"]);
    card.classList.add(controlTypes.has(instance.type) ? "widget-control" : "widget-telemetry");
    card.dataset.widgetId = instance.id;
    card.style.gridColumn = `span ${clamp(instance.w || 4, 2, dashboardGridColumnCount)}`;
    card.style.gridRow = `span ${clamp(instance.h || 2, 1, 6)}`;
    if (instance.pinned) card.classList.add("widget-pinned");
    if (st.focusWidgetId && st.focusWidgetId === instance.id) card.classList.add("widget-focus");

    const head = document.createElement("div");
    head.className = "widget-head";

    const title = document.createElement("div");
    title.className = "widget-title";
    title.innerHTML = `${def.title}${panelRecBadgeHtml(instance)}${instance.pinned && st.editMode ? ' <span class="pin-badge">PIN</span>' : ""}`;

    const actions = document.createElement("div");
    actions.className = "widget-actions";

    if (hasVisibleSettings) {
      actions.appendChild(actionBtn("Settings", () => {
        const panel = card.querySelector(".widget-settings");
        panel.style.display = panel.style.display === "none" ? "block" : "none";
      }));
    }

    if (st.editMode) {
      actions.appendChild(actionBtn(instance.pinned ? "Unpin" : "Pin", () => {
        mutateLayout((l) => {
          const w = l.widgets.find((x) => x.id === instance.id);
          if (w) w.pinned = !w.pinned;
        });
        renderDashboard();
      }));
      actions.appendChild(actionBtn("Remove", () => {
        mutateLayout((l) => { l.widgets = l.widgets.filter((w) => w.id !== instance.id); });
        renderDashboard();
      }));
      head.classList.add("drag-handle");
      head.addEventListener("pointerdown", (e) => startWidgetDrag(e, instance.id, card));
    }

    head.append(title, actions);
    card.appendChild(head);

    if (hasVisibleSettings) {
      const settings = document.createElement("div");
      settings.className = "widget-settings";
      settings.style.display = "none";
      renderSettings(settings, instance, def.settingsSchema);
      card.appendChild(settings);
    }

    const body = document.createElement("div");
    body.className = "widget-content";
    card.appendChild(body);

    if (st.editMode) {
      const handle = document.createElement("div");
      handle.className = "widget-resize-handle";
      handle.title = "Drag to resize";
      handle.addEventListener("pointerdown", (e) => startWidgetResize(e, instance.id, card));
      card.appendChild(handle);
    }

    els.widgetGrid.appendChild(card);
    const cleanup = def.render(body, { instance, store, bus });
    mountedWidgets.set(instance.id, { cleanups: cleanup ? [cleanup] : [], type: instance.type, el: card });
  }
}

function widgetHasVisibleSettings(schema) {
  return Array.isArray(schema) && schema.some((field) => !(field?.type === "device" && field?.key === "device_id"));
}

function renderSettings(container, instance, schema) {
  container.innerHTML = "";
  for (const field of schema) {
    const label = document.createElement("label");
    label.textContent = field.label;
    let input = null;
    if (field.type === "select") {
      input = document.createElement("select");
      for (const v of field.options || []) {
        const opt = document.createElement("option");
        opt.value = String(v);
        opt.textContent = String(v);
        input.appendChild(opt);
      }
    } else if (field.type === "device") {
      input = document.createElement("select");
      const auto = document.createElement("option");
      auto.value = "global";
      auto.textContent = "Global filter";
      input.appendChild(auto);
      for (const d of store.getState().deviceList) {
        const opt = document.createElement("option");
        opt.value = d.device_id;
        const name = d.deviceName ? `${d.deviceName} (${d.device_id})` : d.device_id;
    opt.textContent = name;
        input.appendChild(opt);
      }
    } else {
      input = document.createElement("input");
      input.type = field.type === "number" ? "number" : "text";
      if (field.min != null) input.min = String(field.min);
      if (field.max != null) input.max = String(field.max);
      if (field.step != null) input.step = String(field.step);
    }
    input.value = String(instance.settings?.[field.key] ?? field.default ?? "");
    input.addEventListener("change", () => {
      mutateLayout((layout) => {
        const w = layout.widgets.find((x) => x.id === instance.id);
        if (!w) return;
        w.settings = { ...w.settings, [field.key]: field.type === "number" ? Number(input.value) : input.value };
      });
      renderDashboard();
    });
    label.appendChild(input);
    container.appendChild(label);
  }
}

function startWidgetDrag(e, widgetId, card) {
  if (!store.getState().editMode || store.getState().focusWidgetId) return;
  if (e.button !== 0) return;
  if (e.target.closest("button, input, select, label, a")) return;
  e.preventDefault();

  const rect = card.getBoundingClientRect();
  const startX = e.clientX;
  const startY = e.clientY;
  const startLeft = rect.left;
  const startTop = rect.top;

  const placeholder = document.createElement("article");
  placeholder.className = "card widget-card drag-placeholder";
  placeholder.style.gridColumn = card.style.gridColumn;
  placeholder.style.gridRow = card.style.gridRow;
  placeholder.dataset.widgetId = widgetId;

  els.widgetGrid.insertBefore(placeholder, card.nextSibling);

  card.classList.add("widget-dragging");
  card.style.width = `${rect.width}px`;
  card.style.height = `${rect.height}px`;
  card.style.position = "fixed";
  card.style.left = `${startLeft}px`;
  card.style.top = `${startTop}px`;
  card.style.margin = "0";
  card.style.zIndex = "40";
  card.style.transform = "translate3d(0px, 0px, 0px)";
  card.style.pointerEvents = "none";

  showSnapOverlay(true);

  dragSession = {
    widgetId,
    card,
    placeholder,
    startX,
    startY,
    startLeft,
    startTop,
    dx: 0,
    dy: 0,
    raf: null,
    lastEvent: null
  };

  const onMove = (ev) => {
    if (!dragSession) return;
    dragSession.lastEvent = ev;
    if (dragSession.raf) return;
    dragSession.raf = requestAnimationFrame(() => {
      if (!dragSession) return;
      dragSession.raf = null;
      updateWidgetDrag(dragSession.lastEvent);
    });
  };

  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    finishWidgetDrag();
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function updateWidgetDrag(ev) {
  if (!dragSession || !ev) return;
  const s = dragSession;
  s.dx = ev.clientX - s.startX;
  s.dy = ev.clientY - s.startY;
  s.card.style.transform = `translate3d(${s.dx}px, ${s.dy}px, 0)`;

  const targetIndex = findDropIndex(ev.clientX, ev.clientY, s.widgetId);
  movePlaceholderToIndex(s.placeholder, targetIndex);
  refreshSnapOverlayMetrics();
}

function finishWidgetDrag() {
  if (!dragSession) return;
  const s = dragSession;
  if (s.raf) cancelAnimationFrame(s.raf);

  const orderedIds = [];
  for (const child of els.widgetGrid.children) {
    if (child.classList.contains("grid-snap-overlay")) continue;
    if (child.classList.contains("widget-dragging")) continue;
    if (child.classList.contains("drag-placeholder")) {
      orderedIds.push(s.widgetId);
      continue;
    }
    if (child.classList.contains("widget-card") && child.dataset.widgetId) {
      orderedIds.push(child.dataset.widgetId);
    }
  }

  s.card.classList.remove("widget-dragging");
  s.card.style.width = "";
  s.card.style.height = "";
  s.card.style.position = "";
  s.card.style.left = "";
  s.card.style.top = "";
  s.card.style.margin = "";
  s.card.style.zIndex = "";
  s.card.style.transform = "";
  s.card.style.pointerEvents = "";

  s.placeholder.remove();
  dragSession = null;
  showSnapOverlay(false);

  if (orderedIds.length) {
    mutateLayout((layout) => {
      const byId = new Map(layout.widgets.map((w) => [w.id, w]));
      const picked = [];
      const seen = new Set();
      for (const id of orderedIds) {
        const w = byId.get(id);
        if (w && !seen.has(id)) {
          picked.push(w);
          seen.add(id);
        }
      }
      for (const w of layout.widgets) {
        if (!seen.has(w.id)) picked.push(w);
      }
      layout.widgets = picked;
    });
  }

  renderDashboard();
}

function findDropIndex(x, y, draggingId) {
  const cards = Array.from(els.widgetGrid.querySelectorAll(".widget-card"))
    .filter((el) => !el.classList.contains("widget-dragging") && !el.classList.contains("drag-placeholder"));

  for (let i = 0; i < cards.length; i += 1) {
    const el = cards[i];
    if (el.dataset.widgetId === draggingId) continue;
    const r = el.getBoundingClientRect();
    const midY = r.top + r.height / 2;
    const midX = r.left + r.width / 2;
    const before = (y < midY) || (Math.abs(y - midY) < r.height * 0.3 && x < midX);
    if (before) {
      const allChildren = Array.from(els.widgetGrid.children)
        .filter((c) => (c.classList.contains("widget-card") || c.classList.contains("drag-placeholder")) && !c.classList.contains("widget-dragging"));
      return allChildren.indexOf(el);
    }
  }
  return Array.from(els.widgetGrid.children)
    .filter((c) => (c.classList.contains("widget-card") || c.classList.contains("drag-placeholder")) && !c.classList.contains("widget-dragging")).length;
}

function movePlaceholderToIndex(placeholder, targetIndex) {
  const children = Array.from(els.widgetGrid.children)
    .filter((c) => (c.classList.contains("widget-card") || c.classList.contains("drag-placeholder")) && !c.classList.contains("widget-dragging"));
  const clamped = clamp(targetIndex, 0, children.length);
  const target = children[clamped];
  if (!target) {
    els.widgetGrid.appendChild(placeholder);
    return;
  }
  if (target !== placeholder) {
    els.widgetGrid.insertBefore(placeholder, target);
  }
}

function showSnapOverlay(show) {
  if (!snapOverlayEl) return;
  snapOverlayEl.classList.toggle("show", !!show);
  if (show) refreshSnapOverlayMetrics();
}

function refreshSnapOverlayMetrics() {
  if (!snapOverlayEl) return;
  const gs = getComputedStyle(els.widgetGrid);
  const cols = gs.gridTemplateColumns.split(" ").filter(Boolean).length || 1;
  const rowH = parseFloat(gs.gridAutoRows || "110") || 110;
  const colGap = parseFloat(gs.columnGap || "0") || 0;
  const rowGap = parseFloat(gs.rowGap || "0") || 0;
  const gridW = els.widgetGrid.getBoundingClientRect().width;
  const colW = Math.max(1, (gridW - colGap * (cols - 1)) / cols);

  snapOverlayEl.style.setProperty("--snap-col", `${colW + colGap}px`);
  snapOverlayEl.style.setProperty("--snap-row", `${rowH + rowGap}px`);
}
function resizeWidget(widgetId, dw, dh) {
  mutateLayout((layout) => {
    const w = layout.widgets.find((x) => x.id === widgetId);
    if (!w) return;
    w.w = clamp((w.w || 4) + dw, 2, 12);
    w.h = clamp((w.h || 2) + dh, 1, 6);
  });
  renderDashboard();
}

function resizeWidgetTo(widgetId, nextW, nextH) {
  mutateLayout((layout) => {
    const w = layout.widgets.find((x) => x.id === widgetId);
    if (!w) return;
    w.w = clamp(Number(nextW || w.w || 4), 2, 12);
    w.h = clamp(Number(nextH || w.h || 2), 1, 6);
  });
  renderDashboard();
}

function startWidgetResize(e, widgetId, card) {
  if (!store.getState().editMode) return;
  e.preventDefault();
  e.stopPropagation();

  const layout = getActiveLayout();
  const target = layout?.widgets?.find((w) => w.id === widgetId);
  if (!target) return;

  const startX = e.clientX;
  const startY = e.clientY;
  const startW = Number(target.w || 4);
  const startH = Number(target.h || 2);

  const gridStyle = getComputedStyle(els.widgetGrid);
  const colCount = Math.max(1, gridStyle.gridTemplateColumns.split(" ").filter(Boolean).length);
  const colGap = parseFloat(gridStyle.columnGap || "0") || 0;
  const rowGap = parseFloat(gridStyle.rowGap || "0") || 0;
  const rowPx = parseFloat(gridStyle.gridAutoRows || "110") || 110;
  const gridW = els.widgetGrid.getBoundingClientRect().width;
  const colPx = Math.max(1, (gridW - colGap * (colCount - 1)) / colCount);

  let liveW = startW;
  let liveH = startH;
  showSnapOverlay(true);

  const onMove = (ev) => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    const dCols = Math.round(dx / (colPx + colGap));
    const dRows = Math.round(dy / (rowPx + rowGap));
    liveW = clamp(startW + dCols, 2, 12);
    liveH = clamp(startH + dRows, 1, 6);
    card.style.gridColumn = `span ${liveW}`;
    card.style.gridRow = `span ${liveH}`;
    refreshSnapOverlayMetrics();
  };

  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    showSnapOverlay(false);
    resizeWidgetTo(widgetId, liveW, liveH);
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}
function actionBtn(label, onClick) {
  const b = document.createElement("button");
  b.className = "btn btn-mini";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

async function loadReplaySessions() {
  try {
    const data = await (await fetch("/api/datasets")).json();
    store.setState({ replaySessions: Array.isArray(data.sessions) ? data.sessions : [] });
  } catch {
    store.setState({ replaySessions: [] });
  }
}

async function loadStorageHealth() {
  try {
    const data = await (await fetch("/api/storage")).json();
    store.setState({ storage: data || {} });
  } catch {}
}

function mergeRunConfig(input) {
  const merged = clone(DEFAULT_RUN_CONFIG);
  if (!input || typeof input !== "object") return merged;
  merged.device_id = typeof input.device_id === "string" ? input.device_id : merged.device_id;
  const inS = input.streams || {};
  for (const key of Object.keys(merged.streams)) merged.streams[key] = { ...merged.streams[key], ...(inS[key] || {}) };
  return merged;
}

function sendJson(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
