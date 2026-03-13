import { createStore, createEventBus, clamp, clone, formatElapsed } from "./store.js";
import { ACTIVE_LAYOUT_KEY, defaultLayouts, loadLayouts, normalizeLayout, persistLayouts } from "./layouts.js";
import { createWidgetRegistry, resolveWidgetDevice } from "./widgets.js";

const THEME_KEY = "d3c_theme";

const DEFAULT_RUN_CONFIG = {
  device_id: "phone1",
  streams: {
    imu: { enabled: true, rate_hz: 30, record: true },
    camera: { mode: "off", fps: 10, jpeg_q: 0.6, record: false, record_mode: "jpg", encode_timing: "post_session", video_fps: 10, video_bitrate: "2M", video_crf: 23, downsample_factor: 1 },
    gps: { enabled: false, rate_hz: 1, record: false },
    audio: { enabled: false, rate_hz: 10, record: false },
    device: { enabled: true, rate_hz: 1, record: false },
    fusion: { enabled: true, record: false },
    events: { enabled: true, record: true },
    net: { enabled: true, record: true }
  }
};

const els = {
  themeToggleBtn: document.getElementById("themeToggleBtn"),
  statusConn: document.getElementById("statusConn"),
  statusRec: document.getElementById("statusRec"),
  statusDevices: document.getElementById("statusDevices"),
  statusImu: document.getElementById("statusImu"),
  statusCam: document.getElementById("statusCam"),
  recordingBanner: document.getElementById("recordingBanner"),
  statusAudio: document.getElementById("statusAudio"),
  advancedLayoutBtn: document.getElementById("advancedLayoutBtn"),
  advancedLayoutPanel: document.getElementById("advancedLayoutPanel"),
  globalDeviceFilter: document.getElementById("globalDeviceFilter"),
  viewModeSelect: document.getElementById("viewModeSelect"),
  modeFocusedBtn: document.getElementById("modeFocusedBtn"),
  modeAllBtn: document.getElementById("modeAllBtn"),
  focusedDeviceSelect: document.getElementById("focusedDeviceSelect"),
  viewModeHint: document.getElementById("viewModeHint"),
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
let isAdvancedOpen = false;
let dragSession = null;
let snapOverlayEl = null;
const mountedWidgets = new Map();

const store = createStore({
  wsConnected: false,
  deviceList: [],
  focusedDeviceId: null,
  globalDeviceFilter: "",
  viewMode: "focused",
  statesByDevice: {},
  runConfigsByDevice: {},
  sessionConfig: clone(DEFAULT_RUN_CONFIG),
  sessionJoinCode: "",
  sessionState: "draft",
  recording: { active: false, phase: "IDLE", mode: "focused", session_id: null, session_dir: null, started_at_utc_ms: null, elapsed_sec: 0, devices_recording: 0, devices_online: 0 },
  recordByDevice: {},
  replaySessions: [],
  storage: { sessions_size_gb: 0, session_count: 0, free_disk_bytes: null },
  editMode: false,
  focusWidgetId: null,
  layouts: {},
  activeLayoutName: "Recording"
});

const bus = createEventBus();
const widgetRegistry = createWidgetRegistry({
  store,
  bus,
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
  const active = localStorage.getItem(ACTIVE_LAYOUT_KEY) || "Recording";
  store.setState({
    layouts,
    activeLayoutName: layouts[active] ? active : Object.keys(layouts)[0] || "Recording"
  });

  bindTopUi();
  initTheme();
  renderWidgetTypeOptions();
  renderLayoutSelectors();
  renderDeviceFilter();
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
      focused: s.focusedDeviceId,
      filter: s.globalDeviceFilter,
      viewMode: s.viewMode,
      states: s.statesByDevice
    }),
    () => {
      renderDeviceFilter();
      updateGlobalStatusBar();
  updateRecordingBanner();
    }
  );

  store.subscribe((s) => ({ edit: s.editMode, active: s.activeLayoutName, layouts: s.layouts }), () => {
    if (els.advancedLayoutPanel) els.advancedLayoutPanel.hidden = !store.getState().editMode && !isAdvancedOpen;
    renderLayoutSelectors();
    els.editToolsRow.style.display = store.getState().editMode ? "flex" : "none";
    els.editLayoutBtn.textContent = store.getState().editMode ? "Done Editing" : "Edit Layout";
  });

  updateGlobalStatusBar();
  updateRecordingBanner();

  bus.on("preview_image", (src) => {
    const cameraWidget = [...mountedWidgets.values()].find((m) => m.type === "camera_preview");
    const img = cameraWidget?.el.querySelector("img");
    if (img) img.src = src;
  });
}

function updateGlobalStatusBar() {
  const st = store.getState();
  const onlineCount = (st.deviceList || []).filter((d) => d?.connected !== false).length;

  const selectedId = st.viewMode === "all" ? "" : (st.globalDeviceFilter || st.focusedDeviceId || "");
  const selectedState = selectedId ? st.statesByDevice?.[selectedId] : null;
  let imuHz = Number(selectedState?.net?.imu_hz);
  let camFps = Number(selectedState?.net?.camera_fps);
  if (!Number.isFinite(imuHz)) {
    const rates = (st.deviceList || [])
      .filter((d) => d?.connected !== false)
      .map((d) => Number(d?.imuHz ?? d?.imu_hz))
      .filter((v) => Number.isFinite(v));
    imuHz = rates.length ? Math.max(...rates) : 0;
  }

  setStatusSignal(els.statusConn, st.wsConnected ? "Connected" : "Disconnected", st.wsConnected ? "ok" : "bad");
  setStatusSignal(
    els.statusRec,
    st.recording?.active
      ? `ON (${st.recording.mode || "focused"} ${formatElapsed(st.recording.elapsed_sec || 0)})`
      : "Off",
    st.recording?.active ? "warn" : "bad"
  );
  setStatusSignal(els.statusDevices, `${onlineCount} online`, onlineCount > 0 ? "ok" : "bad");
  setStatusSignal(els.statusImu, `${Math.round(Math.max(0, imuHz))} Hz`, imuHz > 0 ? "ok" : "bad");
  if (!Number.isFinite(camFps)) {
    const cams = (st.deviceList || [])
      .filter((d) => d?.connected !== false)
      .map((d) => Number(d?.camFps ?? d?.cameraFps ?? d?.camera_fps))
      .filter((v) => Number.isFinite(v));
    camFps = cams.length ? Math.max(...cams) : 0;
  }
  setStatusSignal(els.statusCam, `${Math.round(Math.max(0, camFps))} FPS`, camFps > 0 ? "ok" : "warn");

  const audio = selectedState?.audio_latest || {};
  let audioDb = Number(audio.db ?? audio.level_db ?? audio.rms_db);
  const amp = Number(audio.amplitude);
  if (!Number.isFinite(audioDb) && Number.isFinite(amp)) {
    audioDb = 20 * Math.log10(Math.max(1e-6, amp));
  }
  if (!Number.isFinite(audioDb)) audioDb = -120;

  const detected = Boolean(audio.detected ?? audio.voice_detected ?? audio.speech_detected ?? (audioDb > -45));
  const clip = Number(audio.clip_count ?? audio.clipped_samples ?? audio.clip ?? 0);
  const dropouts = Number(audio.dropouts ?? selectedState?.net?.audio_dropouts ?? 0);
  const audioTone = !st.wsConnected ? "bad" : (detected ? "ok" : "warn");
  setAudioStatusSignal(els.statusAudio, {
    db: audioDb,
    detected,
    clip: Number.isFinite(clip) ? clip : 0,
    dropouts: Number.isFinite(dropouts) ? dropouts : 0
  }, audioTone);
}

function setStatusSignal(el, value, tone) {
  if (!el) return;
  const valueEl = el.querySelector(".status-v");
  if (valueEl) valueEl.textContent = value;
  el.classList.remove("is-ok", "is-warn", "is-bad");
  el.classList.add(tone === "warn" ? "is-warn" : tone === "bad" ? "is-bad" : "is-ok");
}
function setAudioStatusSignal(el, data, tone) {
  if (!el) return;
  const dbText = `${Math.round(data.db)} dB`;
  const detectedText = data.detected ? "Detected: ON" : "Detected: Quiet";
  const valueEl = el.querySelector(".status-v");
  const subs = el.querySelectorAll(".status-sub");
  if (valueEl) valueEl.textContent = `Audio Level: ${dbText}`;
  if (subs[0]) subs[0].textContent = detectedText;
  if (subs[1]) subs[1].textContent = `Clip: ${data.clip}`;
  if (subs[2]) subs[2].textContent = `Dropouts: ${data.dropouts}`;
  el.classList.remove("is-ok", "is-warn", "is-bad");
  el.classList.add(tone === "warn" ? "is-warn" : tone === "bad" ? "is-bad" : "is-ok");
}
function updateRecordingBanner() {
  if (!els.recordingBanner) return;
  const st = store.getState();
  const rec = st.recording || {};
  const phase = rec.phase || (rec.active ? "RECORDING" : "IDLE");

  let elapsedSec = Number(rec.elapsed_sec || 0);
  if (Number.isFinite(rec.started_at_utc_ms) && rec.started_at_utc_ms > 0) {
    elapsedSec = Math.max(0, Math.floor((Date.now() - rec.started_at_utc_ms) / 1000));
  }
  const ackStarts = Object.values(st.recordByDevice || {})
    .filter((d) => d?.recording && Number.isFinite(d?.started_at_utc_ms))
    .map((d) => Number(d.started_at_utc_ms));
  if (ackStarts.length) {
    elapsedSec = Math.max(0, Math.floor((Date.now() - Math.min(...ackStarts)) / 1000));
  }
  const elapsed = formatElapsedWide(elapsedSec);
  const session = rec.session_id || "----";

  const byDev = st.recordByDevice || {};
  const recordingCount = Number.isFinite(rec.devices_recording)
    ? Number(rec.devices_recording)
    : Object.values(byDev).filter((d) => d?.recording).length;
  const onlineCount = Number.isFinite(rec.devices_online)
    ? Number(rec.devices_online)
    : (st.deviceList || []).filter((d) => d?.connected !== false).length;

  const banner = els.recordingBanner;
  banner.classList.remove("idle", "recording", "stopping", "error", "ready");

  if (rec.last_error) {
    banner.classList.add("error");
    banner.textContent = `RECORDING ERROR | ${rec.last_error.type || "unknown"}`;
    return;
  }

  if (phase === "STOPPING") {
    banner.classList.add("stopping");
    banner.textContent = `DEVICES FLUSHING  ${elapsed}  | session ${session}  | ${recordingCount}/${onlineCount} devices`;
    return;
  }

  if (phase === "RECORDING" && recordingCount > 0) {
    banner.classList.add("recording");
    banner.textContent = `RECORDING  ${elapsed}  | session ${session}  | ${recordingCount}/${onlineCount} devices`;
    return;
  }

  if (st.wsConnected && onlineCount > 0) {
    banner.classList.add("ready");
    banner.textContent = `SYSTEM READY  | ${onlineCount} devices online`;
    return;
  }

  if (st.wsConnected) {
    banner.classList.add("idle");
    banner.textContent = `DEVICES CONNECTING`;
    return;
  }

  banner.classList.add("idle");
  banner.textContent = `OFFLINE`;
}
function formatElapsedWide(totalSec) {
  const s = Math.max(0, Number(totalSec || 0));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (hh > 0) return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function widgetModality(widgetType) {
  if (widgetType === "imu_plot") return "imu";
  if (widgetType === "camera_preview") return "cam";
  if (widgetType === "audio_live") return "audio";
  if (widgetType === "gps_live") return "gps";
  return null;
}

function panelRecBadgeHtml(instance) {
  const modality = widgetModality(instance.type);
  if (!modality) return "";
  const st = store.getState();
  const deviceId = resolveWidgetDevice(instance.settings, st);
  const rec = st.recordByDevice?.[deviceId];
  const on = !!rec?.recording && !!rec?.modalities?.[modality];
  return on
    ? ' <span class="panel-rec rec-on" title="Recording to disk">REC ON</span>'
    : ' <span class="panel-rec rec-off" title="Not recording to disk">REC OFF</span>';
}
function bindTopUi() {
  if (els.advancedLayoutBtn && els.advancedLayoutPanel) {
    els.advancedLayoutBtn.addEventListener("click", () => {
      isAdvancedOpen = !isAdvancedOpen;
      els.advancedLayoutPanel.hidden = !isAdvancedOpen && !store.getState().editMode;
      els.advancedLayoutBtn.textContent = isAdvancedOpen ? "Hide Advanced" : "Advanced Layout";
    });
  }
  els.themeToggleBtn.addEventListener("click", toggleTheme);

  const setViewMode = (mode) => {
    const normalized = mode === "all" ? "all" : "focused";
    const st = store.getState();
    store.setState({
      viewMode: normalized,
      globalDeviceFilter: normalized === "all" ? "" : (st.globalDeviceFilter || st.focusedDeviceId || "")
    });
    if (els.viewModeSelect) els.viewModeSelect.value = normalized;
    renderDeviceFilter();
    renderDashboard();
  };

  els.viewModeSelect?.addEventListener("change", () => setViewMode(els.viewModeSelect.value));
  els.modeFocusedBtn?.addEventListener("click", () => setViewMode("focused"));
  els.modeAllBtn?.addEventListener("click", () => setViewMode("all"));

  els.focusedDeviceSelect?.addEventListener("change", () => {
    const id = els.focusedDeviceSelect.value || "";
    store.setState({ globalDeviceFilter: id, viewMode: "focused" });
    if (els.viewModeSelect) els.viewModeSelect.value = "focused";
    if (id) sendJson({ type: "set_focus", device_id: id });
    renderDashboard();
  });
  els.globalDeviceFilter.addEventListener("change", () => {
    const id = els.globalDeviceFilter.value || "";
    store.setState({ globalDeviceFilter: id, viewMode: "focused" });
    if (els.viewModeSelect) els.viewModeSelect.value = "focused";
    if (id) sendJson({ type: "set_focus", device_id: id });
    renderDashboard();
  });

  els.editLayoutBtn.addEventListener("click", () => {
    store.setState({ editMode: !store.getState().editMode });
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
}

function connectWs() {
  const wsScheme = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${wsScheme}://${location.host}/ws`);
  ws.onopen = () => {
    store.setState({ wsConnected: true });
    sendJson({ type: "hello", role: "dashboard" });
  };
  ws.onclose = () => {
    store.setState({ wsConnected: false });
    setTimeout(connectWs, 1000);
  };
  ws.onmessage = (ev) => {
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg) return;

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

    if (msg.type === "focus") {
      if (msg.focused_device_id) store.setState({ focusedDeviceId: msg.focused_device_id });
      return;
    }

    if (msg.type === "config") {
      const id = msg.device_id || store.getState().focusedDeviceId;
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
            session_id: msg.session_id || null,
            started_at_utc_ms: msg.started_at_utc_ms || null,
            modalities: msg.modalities || { imu: false, cam: false, audio: false },
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
            recording: false,
            modalities: { imu: false, cam: false, audio: false },
            files: msg.files || prev.files || {}
          }
        }
      });
      return;
    }

    if (msg.type === "state") {
      const st = store.getState();
      const focusedId = msg.focused_device_id || st.focusedDeviceId;
      const byDevice = { ...st.statesByDevice };
      if (msg.device_states && typeof msg.device_states === "object") {
        for (const [id, state] of Object.entries(msg.device_states)) byDevice[id] = state;
      } else if (focusedId && msg.focused) {
        byDevice[focusedId] = msg.focused;
      }
      store.setState({
        focusedDeviceId: focusedId,
        deviceList: Array.isArray(msg.devices) ? msg.devices : st.deviceList,
        statesByDevice: byDevice,
        recording: msg.recording || st.recording,
        sessionConfig: mergeRunConfig(msg.sessionConfig || st.sessionConfig || DEFAULT_RUN_CONFIG),
        sessionState: msg.sessionState || ((msg.recording || st.recording).active ? "active" : "draft")
      });
      if (!store.getState().globalDeviceFilter && focusedId) {
        store.setState({ globalDeviceFilter: focusedId });
      }
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
}


function computeFleetActiveCounts(st, freshnessMs = 4000) {
  const now = Date.now();
  const connected = (st.deviceList || []).filter((d) => d?.connected !== false);
  let imu = 0;
  let cam = 0;
  let audio = 0;
  let gps = 0;

  for (const d of connected) {
    const s = st.statesByDevice?.[d.device_id] || {};
    const imuTs = Number(s.imu_latest?.t_recv_ms || 0);
    const camTs = Number(s.camera_latest_ts || 0);
    const audioTs = Number(s.audio_latest?.t_recv_ms || 0);
    const gpsTs = Number(s.gps_latest?.t_recv_ms || 0);
    if (imuTs && (now - imuTs) <= freshnessMs) imu += 1;
    if (camTs && (now - camTs) <= freshnessMs) cam += 1;
    if (audioTs && (now - audioTs) <= freshnessMs) audio += 1;
    if (gpsTs && (now - gpsTs) <= freshnessMs) gps += 1;
  }

  return { total: connected.length, imu, cam, audio, gps };
}

function renderDeviceFilter() {
  const st = store.getState();

  const fillDeviceSelect = (sel, includeAuto) => {
    if (!sel) return;
    sel.innerHTML = "";
    if (includeAuto) {
      const auto = document.createElement("option");
      auto.value = "";
      auto.textContent = "Auto (focused)";
      sel.appendChild(auto);
    }
    for (const d of st.deviceList) {
      const opt = document.createElement("option");
      opt.value = d.device_id;
      const name = d.deviceName ? `${d.deviceName} (${d.device_id})` : d.device_id;
      opt.textContent = name;
      sel.appendChild(opt);
    }
  };

  fillDeviceSelect(els.globalDeviceFilter, true);
  fillDeviceSelect(els.focusedDeviceSelect, false);

  if (els.focusedDeviceSelect) {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "No device selected";
    els.focusedDeviceSelect.insertBefore(placeholder, els.focusedDeviceSelect.firstChild);
  }

  if (els.viewModeSelect) els.viewModeSelect.value = st.viewMode || "focused";
  if (els.modeFocusedBtn && els.modeAllBtn) {
    const focused = (st.viewMode || "focused") !== "all";
    els.modeFocusedBtn.classList.toggle("active", focused);
    els.modeAllBtn.classList.toggle("active", !focused);
    els.modeFocusedBtn.setAttribute("aria-pressed", focused ? "true" : "false");
    els.modeAllBtn.setAttribute("aria-pressed", !focused ? "true" : "false");
  }

  if (els.viewModeHint) {
    const on = (st.viewMode === "all");
    els.viewModeHint.hidden = !on;
    if (on) {
      const c = computeFleetActiveCounts(st);
      els.viewModeHint.textContent = "All Devices mode active | IMU " + c.imu + "/" + c.total + " | Camera " + c.cam + "/" + c.total + " | Audio " + c.audio + "/" + c.total + " | GPS " + c.gps + "/" + c.total;
    } else {
      els.viewModeHint.textContent = "";
    }
  }

  const selectedId = st.globalDeviceFilter || st.focusedDeviceId || "";
  if (els.globalDeviceFilter) {
    els.globalDeviceFilter.value = selectedId;
    els.globalDeviceFilter.disabled = (st.viewMode === "all");
  }
  if (els.focusedDeviceSelect) {
    els.focusedDeviceSelect.value = selectedId;
    els.focusedDeviceSelect.disabled = (st.viewMode === "all");
  }
}

function renderDashboard() {
  for (const m of mountedWidgets.values()) for (const c of m.cleanups) c();
  mountedWidgets.clear();
  els.widgetGrid.innerHTML = "";
  dragSession = null;

  snapOverlayEl = document.createElement("div");
  snapOverlayEl.className = "grid-snap-overlay";
  els.widgetGrid.appendChild(snapOverlayEl);

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

    const card = document.createElement("article");
    card.className = "card widget-card";
    const controlTypes = new Set(["stream_controls", "events_timeline", "replay"]);
    card.classList.add(controlTypes.has(instance.type) ? "widget-control" : "widget-telemetry");
    card.dataset.widgetId = instance.id;
    card.style.gridColumn = `span ${clamp(instance.w || 4, 2, 12)}`;
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
    actions.appendChild(actionBtn(st.focusWidgetId === instance.id ? "Exit Focus" : "Focus", () => {
      store.setState({ focusWidgetId: st.focusWidgetId === instance.id ? null : instance.id });
      renderDashboard();
    }));

    if (def.settingsSchema?.length) {
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

    const settings = document.createElement("div");
    settings.className = "widget-settings";
    settings.style.display = "none";
    if (def.settingsSchema?.length) renderSettings(settings, instance, def.settingsSchema);
    card.appendChild(settings);

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

function initTheme() {
  applyTheme(localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light");
}

function toggleTheme() {
  applyTheme((document.body.getAttribute("data-theme") || "light") === "light" ? "dark" : "light");
}

function applyTheme(theme) {
  document.body.setAttribute("data-theme", theme);
  localStorage.setItem(THEME_KEY, theme);
  els.themeToggleBtn.textContent = theme === "light" ? "Dark Mode" : "Light Mode";
}



















































