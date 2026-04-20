import { escapeHtml } from "./store.js";

const AUTO_REFRESH_MS = 5000;

const els = {
  logoutBtn: document.getElementById("logoutBtn"),
  refreshStatus: document.getElementById("datasetsRefreshStatus"),
  refreshBtn: document.getElementById("refreshDatasetsBtn"),
  overviewGrid: document.getElementById("datasetsOverviewGrid"),
  filterInput: document.getElementById("datasetsFilterInput"),
  list: document.getElementById("datasetsList"),
  detail: document.getElementById("datasetsDetail")
};

const state = {
  summaries: [],
  storage: { sessions_size_gb: 0, session_count: 0, free_disk_bytes: null },
  selectedSessionId: "",
  selectedDeviceId: "",
  filter: "",
  manifest: null,
  meta: null,
  sync: null,
  flash: null,
  loadingOverview: false,
  loadingDetail: false,
  actionBusy: "",
  lastRefreshAtMs: 0
};

let overviewRequestToken = 0;
let detailRequestToken = 0;
let refreshTimer = null;

init();

function init() {
  bindUi();
  syncSelectionFromUrl();
  renderOverview();
  renderList();
  renderDetail();
  void refreshAll();
  refreshTimer = window.setInterval(() => {
    if (!document.hidden) void refreshAll();
  }, AUTO_REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refreshAll();
  });
}

function bindUi() {
  els.logoutBtn?.addEventListener("click", async () => {
    try {
      await fetch("/api/dashboard/logout", { method: "POST" });
    } catch {}
    window.location.assign("/dashboard/login");
  });

  els.refreshBtn?.addEventListener("click", () => {
    void refreshAll({ forceFlash: { tone: "info", message: "Refreshing dataset library..." } });
  });

  els.filterInput?.addEventListener("input", () => {
    state.filter = String(els.filterInput.value || "").trim().toLowerCase();
    renderList();
  });
}

async function refreshAll({ forceFlash = null } = {}) {
  if (forceFlash) {
    state.flash = forceFlash;
    renderDetail();
  }
  await loadOverview();
  await loadSelectedDetail();
}

async function loadOverview() {
  const token = ++overviewRequestToken;
  state.loadingOverview = true;
  renderOverview();
  updateRefreshStatus();
  try {
    const [datasetPayload, storagePayload] = await Promise.all([
      fetchJson("/api/datasets"),
      fetchJson("/api/storage")
    ]);
    if (token !== overviewRequestToken) return;
    state.summaries = Array.isArray(datasetPayload?.summaries) ? datasetPayload.summaries : [];
    state.storage = storagePayload || state.storage;
    normalizeSelection();
    state.lastRefreshAtMs = Date.now();
  } catch (error) {
    if (token !== overviewRequestToken) return;
    state.flash = { tone: "error", message: `Could not refresh dataset list: ${String(error.message || error)}` };
  } finally {
    if (token === overviewRequestToken) {
      state.loadingOverview = false;
      renderOverview();
      renderList();
      updateRefreshStatus();
    }
  }
}

async function loadSelectedDetail() {
  const selected = getSelectedSummary();
  if (!selected) {
    state.manifest = null;
    state.meta = null;
    state.sync = null;
    state.loadingDetail = false;
    renderDetail();
    return;
  }

  const token = ++detailRequestToken;
  state.loadingDetail = true;
  renderDetail();

  try {
    const query = state.selectedDeviceId ? `?device_id=${encodeURIComponent(state.selectedDeviceId)}` : "";
    const manifest = await fetchJson(`/api/datasets/${encodeURIComponent(selected.id)}/manifest${query}`);
    const [meta, sync] = await Promise.all([
      manifest.metaJson ? fetchJson(manifest.metaJson) : Promise.resolve(null),
      manifest.syncReportJson ? fetchJson(manifest.syncReportJson) : Promise.resolve(null)
    ]);
    if (token !== detailRequestToken) return;

    state.manifest = manifest;
    state.meta = meta;
    state.sync = sync;

    const deviceIds = getAvailableDeviceIds(selected, manifest, meta, sync);
    if (!deviceIds.includes(state.selectedDeviceId)) {
      state.selectedDeviceId = manifest.device_id || deviceIds[0] || "";
      syncSelectionToUrl();
    }
  } catch (error) {
    if (token !== detailRequestToken) return;
    state.manifest = null;
    state.meta = null;
    state.sync = null;
    state.flash = { tone: "error", message: `Could not load dataset details: ${String(error.message || error)}` };
  } finally {
    if (token === detailRequestToken) {
      state.loadingDetail = false;
      renderDetail();
    }
  }
}

function normalizeSelection() {
  const ids = state.summaries.map((summary) => summary.id);
  if (!ids.length) {
    state.selectedSessionId = "";
    state.selectedDeviceId = "";
    syncSelectionToUrl();
    return;
  }
  if (!state.selectedSessionId || !ids.includes(state.selectedSessionId)) {
    state.selectedSessionId = ids[0];
    state.selectedDeviceId = "";
  }
  syncSelectionToUrl();
}

function getSelectedSummary() {
  return state.summaries.find((summary) => summary.id === state.selectedSessionId) || null;
}

function syncSelectionFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const session = String(params.get("session") || "").trim();
  const device = String(params.get("device") || "").trim();
  if (session) state.selectedSessionId = session;
  if (device) state.selectedDeviceId = device;
}

function syncSelectionToUrl() {
  const params = new URLSearchParams(window.location.search);
  if (state.selectedSessionId) params.set("session", state.selectedSessionId);
  else params.delete("session");
  if (state.selectedDeviceId) params.set("device", state.selectedDeviceId);
  else params.delete("device");
  const next = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`;
  window.history.replaceState({}, "", next);
}

function updateRefreshStatus() {
  if (!els.refreshStatus) return;
  if (state.loadingOverview) {
    els.refreshStatus.textContent = "Refreshing dataset library...";
    return;
  }
  if (!state.lastRefreshAtMs) {
    els.refreshStatus.textContent = `Auto refresh every ${Math.round(AUTO_REFRESH_MS / 1000)}s`;
    return;
  }
  els.refreshStatus.textContent = `Updated ${formatTime(state.lastRefreshAtMs)} · Auto refresh ${Math.round(AUTO_REFRESH_MS / 1000)}s`;
}

function renderOverview() {
  if (!els.overviewGrid) return;
  const activeCount = state.summaries.filter((summary) => summary.active).length;
  const newest = state.summaries[0] || null;
  const cards = [
    {
      label: "Sessions",
      value: String(state.storage?.session_count ?? state.summaries.length ?? 0),
      hint: state.loadingOverview ? "Refreshing session folders..." : "Recorded datasets on disk"
    },
    {
      label: "Storage Used",
      value: formatStorageGb(state.storage?.sessions_size_gb),
      hint: "Total size under datasets/"
    },
    {
      label: "Free Disk",
      value: formatBytes(state.storage?.free_disk_bytes),
      hint: "Remaining free space on this machine"
    },
    {
      label: "Latest Session",
      value: newest ? formatSessionLabel(newest.id) : "None",
      hint: activeCount ? `${activeCount} active ${activeCount === 1 ? "recording" : "recordings"}` : "No active recordings"
    }
  ];

  els.overviewGrid.innerHTML = cards.map((card) => `
    <article class="status-card datasets-overview-card">
      <span class="status-label">${escapeHtml(card.label)}</span>
      <div class="status-value">
        <span class="status-text">${escapeHtml(card.value)}</span>
      </div>
      <p class="datasets-overview-hint">${escapeHtml(card.hint)}</p>
    </article>
  `).join("");
}

function renderList() {
  if (!els.list) return;
  const filtered = state.summaries.filter((summary) => datasetMatchesFilter(summary, state.filter));
  if (!filtered.length) {
    els.list.innerHTML = `
      <div class="datasets-empty">
        <strong>No datasets found</strong>
        <p>${state.filter ? "Try a different filter." : "Start a recording and the session folder will appear here."}</p>
      </div>
    `;
    return;
  }

  els.list.innerHTML = filtered.map((summary) => {
    const active = summary.id === state.selectedSessionId;
    const modalities = Array.isArray(summary.requested_modalities) && summary.requested_modalities.length
      ? summary.requested_modalities.map(formatModalityLabel).join(", ")
      : "No capture plan recorded";
    const exportText = summary.export_count ? `${summary.export_count} exports` : "Raw files only";
    const deviceNames = Object.values(summary.device_names || {});
    const deviceText = deviceNames.length ? deviceNames.join(", ") : `${summary.device_count || 0} device${summary.device_count === 1 ? "" : "s"}`;
    return `
      <button type="button" class="datasets-list-item${active ? " is-active" : ""}" data-session-id="${escapeHtml(summary.id)}">
        <div class="datasets-list-head">
          <div>
            <strong>${escapeHtml(formatSessionLabel(summary.id))}</strong>
            <div class="datasets-list-subtitle">${escapeHtml(summary.session_name || summary.id)}</div>
          </div>
          <div class="datasets-list-badges">
            ${summary.active ? '<span class="datasets-badge is-live">Live</span>' : ""}
            <span class="datasets-badge">${escapeHtml(exportText)}</span>
          </div>
        </div>
        <div class="datasets-list-meta">${escapeHtml(formatDate(summary.created_at_iso))} · ${escapeHtml(deviceText)}</div>
        <div class="datasets-list-copy">${escapeHtml(modalities)}</div>
      </button>
    `;
  }).join("");

  for (const button of els.list.querySelectorAll("[data-session-id]")) {
    button.addEventListener("click", () => {
      const nextId = String(button.getAttribute("data-session-id") || "");
      if (!nextId || nextId === state.selectedSessionId) return;
      state.selectedSessionId = nextId;
      state.selectedDeviceId = "";
      state.flash = null;
      syncSelectionToUrl();
      renderList();
      void loadSelectedDetail();
    });
  }
}

function renderDetail() {
  if (!els.detail) return;
  const summary = getSelectedSummary();
  if (!summary) {
    els.detail.innerHTML = `
      <div class="datasets-empty datasets-detail-empty">
        <strong>No dataset selected</strong>
        <p>The dataset library will populate automatically as session folders appear.</p>
      </div>
    `;
    return;
  }

  const manifest = state.manifest;
  const meta = state.meta || {};
  const sync = state.sync || {};
  const deviceIds = getAvailableDeviceIds(summary, manifest, meta, sync);
  const selectedDeviceId = deviceIds.includes(state.selectedDeviceId)
    ? state.selectedDeviceId
    : (manifest?.device_id || deviceIds[0] || "");
  const previewUrl = pickPreviewUrl(manifest);
  const detailMetrics = buildDetailMetrics(summary, manifest, meta, sync);
  const exportLinks = buildExportLinks(manifest);
  const rawLinks = buildRawLinks(manifest);
  const deviceCards = buildDeviceCards(summary, meta, sync, selectedDeviceId);

  els.detail.innerHTML = `
    <div class="datasets-detail-head">
      <div class="datasets-detail-copy">
        <span class="workspace-bar-label">Dataset</span>
        <h2>${escapeHtml(summary.session_name || summary.id)}</h2>
        <p class="workspace-panel-text">${escapeHtml(formatSessionDescription(summary, meta))}</p>
      </div>
      <div class="datasets-detail-actions">
        <button type="button" class="btn btn-alt btn-small" data-action="refresh-detail">Refresh</button>
        <button type="button" class="btn btn-alt btn-small" data-action="generate-exports"${state.actionBusy ? " disabled" : ""}>Generate Exports</button>
        <button type="button" class="btn btn-alt btn-small" data-action="delete-dataset"${state.actionBusy ? " disabled" : ""}>Delete</button>
      </div>
    </div>

    ${state.flash ? `<div class="datasets-flash is-${escapeHtml(state.flash.tone || "info")}">${escapeHtml(state.flash.message || "")}</div>` : ""}
    ${state.loadingDetail ? `<div class="datasets-flash is-info">Refreshing dataset details...</div>` : ""}

    <div class="kv-grid datasets-detail-metrics">
      ${detailMetrics.map((item) => `
        <div class="kv-item">
          <span class="muted mono">${escapeHtml(item.label)}</span>
          <strong>${escapeHtml(item.value)}</strong>
        </div>
      `).join("")}
    </div>

    <div class="datasets-detail-grid">
      <section class="datasets-panel datasets-preview-panel">
        <div class="datasets-panel-head">
          <div>
            <span class="workspace-bar-label">Preview</span>
            <h3>Session Media</h3>
          </div>
          <span class="datasets-panel-meta">${escapeHtml(previewUrl ? "Preview ready" : "No video export yet")}</span>
        </div>
        ${previewUrl
          ? `<video class="datasets-preview-video" controls preload="metadata" src="${escapeHtml(previewUrl)}"></video>`
          : `<div class="datasets-preview-empty">No multiview or camera video is available yet for this session.</div>`}
      </section>

      <section class="datasets-panel">
        <div class="datasets-panel-head">
          <div>
            <span class="workspace-bar-label">Exports</span>
            <h3>Artifacts</h3>
          </div>
          <span class="datasets-panel-meta">${escapeHtml(exportLinks.length ? `${exportLinks.length} files` : "Pending")}</span>
        </div>
        <div class="datasets-link-grid">
          ${exportLinks.length
            ? exportLinks.map((link) => renderLinkCard(link)).join("")
            : '<div class="datasets-inline-empty">No exported artifacts yet. Use Generate Exports to build them.</div>'}
        </div>
      </section>

      <section class="datasets-panel">
        <div class="datasets-panel-head">
          <div>
            <span class="workspace-bar-label">Devices</span>
            <h3>Recorded Phones</h3>
          </div>
          <span class="datasets-panel-meta">${escapeHtml(`${deviceIds.length} device${deviceIds.length === 1 ? "" : "s"}`)}</span>
        </div>
        <div class="datasets-device-grid">
          ${deviceCards.length
            ? deviceCards.map((card) => `
              <button type="button" class="datasets-device-card${card.deviceId === selectedDeviceId ? " is-active" : ""}" data-device-id="${escapeHtml(card.deviceId)}">
                <div class="datasets-device-head">
                  <strong>${escapeHtml(card.name)}</strong>
                  <span class="datasets-badge">${escapeHtml(card.status)}</span>
                </div>
                <div class="datasets-device-sub">${escapeHtml(card.deviceId)}</div>
                <div class="datasets-device-copy">${escapeHtml(card.copy)}</div>
              </button>
            `).join("")
            : '<div class="datasets-inline-empty">No device details found for this session.</div>'}
        </div>
      </section>

      <section class="datasets-panel datasets-streams-panel">
        <div class="datasets-panel-head">
          <div>
            <span class="workspace-bar-label">Raw Files</span>
            <h3>${escapeHtml(selectedDeviceId || "Device Streams")}</h3>
          </div>
          ${deviceIds.length > 1 ? `
            <label class="datasets-device-select">
              Device
              <select id="datasetsDeviceSelect">
                ${deviceIds.map((deviceId) => `<option value="${escapeHtml(deviceId)}"${deviceId === selectedDeviceId ? " selected" : ""}>${escapeHtml(summary.device_names?.[deviceId] || deviceId)}</option>`).join("")}
              </select>
            </label>
          ` : ""}
        </div>
        <div class="datasets-link-grid">
          ${rawLinks.length
            ? rawLinks.map((link) => renderLinkCard(link)).join("")
            : '<div class="datasets-inline-empty">No stream files are available for the selected device yet.</div>'}
        </div>
      </section>
    </div>
  `;

  const refreshBtn = els.detail.querySelector('[data-action="refresh-detail"]');
  refreshBtn?.addEventListener("click", () => {
    state.flash = { tone: "info", message: "Refreshing dataset details..." };
    renderDetail();
    void loadSelectedDetail();
  });

  const exportBtn = els.detail.querySelector('[data-action="generate-exports"]');
  exportBtn?.addEventListener("click", () => {
    void handleGenerateExports(summary.id);
  });

  const deleteBtn = els.detail.querySelector('[data-action="delete-dataset"]');
  deleteBtn?.addEventListener("click", () => {
    void handleDeleteDataset(summary.id);
  });

  for (const button of els.detail.querySelectorAll("[data-device-id]")) {
    button.addEventListener("click", () => {
      const nextDeviceId = String(button.getAttribute("data-device-id") || "");
      if (!nextDeviceId || nextDeviceId === state.selectedDeviceId) return;
      state.selectedDeviceId = nextDeviceId;
      syncSelectionToUrl();
      void loadSelectedDetail();
    });
  }

  const deviceSelect = els.detail.querySelector("#datasetsDeviceSelect");
  deviceSelect?.addEventListener("change", () => {
    state.selectedDeviceId = String(deviceSelect.value || "");
    syncSelectionToUrl();
    void loadSelectedDetail();
  });
}

async function handleGenerateExports(sessionId) {
  state.actionBusy = "exports";
  state.flash = { tone: "info", message: "Generating exports..." };
  renderDetail();
  try {
    await fetchJson(`/api/datasets/${encodeURIComponent(sessionId)}/exports`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    state.flash = { tone: "success", message: "Exports generated successfully." };
    await refreshAll();
  } catch (error) {
    state.flash = { tone: "error", message: `Export generation failed: ${String(error.message || error)}` };
    renderDetail();
  } finally {
    state.actionBusy = "";
    renderDetail();
  }
}

async function handleDeleteDataset(sessionId) {
  const confirmed = window.confirm(`Delete ${sessionId}? This removes the dataset folder from disk.`);
  if (!confirmed) return;
  state.actionBusy = "delete";
  state.flash = { tone: "warn", message: `Deleting ${sessionId}...` };
  renderDetail();
  try {
    await fetchJson(`/api/datasets/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    state.flash = { tone: "success", message: `${sessionId} deleted.` };
    if (state.selectedSessionId === sessionId) {
      state.selectedSessionId = "";
      state.selectedDeviceId = "";
    }
    await loadOverview();
    await loadSelectedDetail();
  } catch (error) {
    state.flash = { tone: "error", message: `Delete failed: ${String(error.message || error)}` };
  } finally {
    state.actionBusy = "";
    renderDetail();
  }
}

function buildDetailMetrics(summary, manifest, meta, sync) {
  const requested = Array.isArray(summary.requested_modalities) && summary.requested_modalities.length
    ? summary.requested_modalities.map(formatModalityLabel).join(", ")
    : "Unknown";
  const updatedAt = summary.updated_at_ms ? formatDate(summary.updated_at_ms) : "Unknown";
  return [
    { label: "Session", value: formatSessionLabel(summary.id) },
    { label: "Created", value: formatDate(summary.created_at_iso) },
    { label: "Updated", value: updatedAt },
    { label: "Devices", value: String(summary.device_count || getAvailableDeviceIds(summary, manifest, meta, sync).length || 0) },
    { label: "Capture", value: requested },
    { label: "Exports", value: String(summary.export_count || 0) }
  ];
}

function buildExportLinks(manifest) {
  if (!manifest) return [];
  const exports = manifest.sessionExports || {};
  const items = [
    { label: "Multiview MP4", href: exports.multiview, kind: "video" },
    { label: "Multiview + Audio", href: exports.multiviewWithAudio, kind: "video" },
    { label: "Multiview + Audio + GPS", href: exports.multiviewWithAudioAndGps, kind: "video" },
    { label: "Export Manifest", href: exports.manifestJson, kind: "json" },
    { label: "GPS Playback JSON", href: exports.gpsPlaybackJson, kind: "json" },
    { label: "GPS Playback Video", href: exports.gpsPlaybackVideo, kind: "video" },
    { label: "Session Meta", href: manifest.metaJson, kind: "json" },
    { label: "Sync Report", href: manifest.syncReportJson, kind: "json" }
  ];
  return items.filter((item) => !!item.href);
}

function buildRawLinks(manifest) {
  if (!manifest) return [];
  const items = [
    { label: "IMU CSV", href: manifest.imuCsv, kind: "csv" },
    { label: "IMU Parquet", href: manifest.imuParquet, kind: "parquet" },
    { label: "GPS CSV", href: manifest.gpsCsv, kind: "csv" },
    { label: "GPS Parquet", href: manifest.gpsParquet, kind: "parquet" },
    { label: "Audio WAV", href: manifest.audioWav, kind: "audio" },
    { label: "Audio CSV", href: manifest.audioCsv, kind: "csv" },
    { label: "Audio Chunks CSV", href: manifest.audioChunksCsv, kind: "csv" },
    { label: "Audio Parquet", href: manifest.audioParquet, kind: "parquet" },
    { label: "Camera MP4", href: manifest.cameraVideo, kind: "video" },
    { label: "Camera + Audio", href: manifest.cameraWithAudio, kind: "video" },
    { label: "Camera Timestamps", href: manifest.cameraTimestampsCsv, kind: "csv" },
    { label: "Camera Frames", href: manifest.cameraDir, kind: "dir" },
    { label: "Events CSV", href: manifest.eventsCsv, kind: "csv" },
    { label: "Events Parquet", href: manifest.eventsParquet, kind: "parquet" },
    { label: "Device CSV", href: manifest.deviceCsv, kind: "csv" },
    { label: "Device Parquet", href: manifest.deviceParquet, kind: "parquet" },
    { label: "Fusion CSV", href: manifest.fusionCsv, kind: "csv" },
    { label: "Fusion Parquet", href: manifest.fusionParquet, kind: "parquet" },
    { label: "Network CSV", href: manifest.netCsv, kind: "csv" },
    { label: "Network Parquet", href: manifest.netParquet, kind: "parquet" }
  ];
  return items.filter((item) => !!item.href);
}

function buildDeviceCards(summary, meta, sync, selectedDeviceId) {
  const ids = getAvailableDeviceIds(summary, state.manifest, meta, sync);
  return ids.map((deviceId) => {
    const syncDevice = sync?.devices?.[deviceId] || {};
    const runConfig = meta?.devices?.[deviceId]?.runConfig || {};
    const alerts = Array.isArray(syncDevice.alerts) ? syncDevice.alerts : [];
    const modalities = [];
    if (runConfig?.streams?.imu?.enabled) modalities.push("motion");
    if (String(runConfig?.streams?.camera?.mode || "off") !== "off") modalities.push("camera");
    if (runConfig?.streams?.gps?.enabled) modalities.push("location");
    if (runConfig?.streams?.audio?.enabled) modalities.push("audio");
    return {
      deviceId,
      name: summary.device_names?.[deviceId] || syncDevice.device_name || deviceId,
      status: syncDevice.connection_status || (deviceId === selectedDeviceId ? "selected" : "recorded"),
      copy: alerts.length
        ? alerts.map((alert) => String(alert.message || alert.code || "alert")).join(" · ")
        : (modalities.length ? `${modalities.join(", ")} captured` : "Recorded in this session")
    };
  });
}

function datasetMatchesFilter(summary, filter) {
  if (!filter) return true;
  const haystack = [
    summary.id,
    summary.session_name,
    summary.focused_device_id,
    ...(summary.device_ids || []),
    ...Object.values(summary.device_names || {})
  ].join(" ").toLowerCase();
  return haystack.includes(filter);
}

function getAvailableDeviceIds(summary, manifest, meta, sync) {
  const ids = new Set();
  for (const value of summary?.device_ids || []) ids.add(String(value));
  for (const value of summary?.target_device_ids || []) ids.add(String(value));
  for (const value of Object.keys(meta?.devices || {})) ids.add(String(value));
  for (const value of Object.keys(sync?.devices || {})) ids.add(String(value));
  if (manifest?.device_id) ids.add(String(manifest.device_id));
  return [...ids].filter(Boolean).sort();
}

function pickPreviewUrl(manifest) {
  if (!manifest) return "";
  const exports = manifest.sessionExports || {};
  return exports.multiviewWithAudioAndGps
    || exports.multiviewWithAudio
    || exports.multiview
    || manifest.cameraWithAudio
    || manifest.cameraVideo
    || "";
}

function renderLinkCard(link) {
  return `
    <a class="datasets-link-card" href="${escapeHtml(link.href)}" target="_blank" rel="noreferrer noopener">
      <span class="datasets-link-kind">${escapeHtml(link.kind.toUpperCase())}</span>
      <strong>${escapeHtml(link.label)}</strong>
      <span class="datasets-link-meta">${escapeHtml(link.href.split("/").slice(-1)[0] || link.href)}</span>
    </a>
  `;
}

function formatSessionDescription(summary, meta) {
  const modalities = Array.isArray(summary.requested_modalities) && summary.requested_modalities.length
    ? summary.requested_modalities.map(formatModalityLabel).join(", ")
    : "capture plan unavailable";
  const targetCount = Array.isArray(meta?.target_device_ids) && meta.target_device_ids.length
    ? meta.target_device_ids.length
    : summary.device_count || 0;
  return `${targetCount} recorded ${targetCount === 1 ? "device" : "devices"} · ${modalities} · ${summary.recording_mode || "all"} mode`;
}

function formatSessionLabel(id) {
  return String(id || "").replace(/^session_/, "").replace(/_/g, " ");
}

function formatModalityLabel(value) {
  const key = String(value || "").toLowerCase();
  if (key === "imu") return "Motion";
  if (key === "cam" || key === "camera") return "Camera";
  if (key === "audio") return "Audio";
  if (key === "gps" || key === "location") return "Location";
  return key || "Unknown";
}

function formatStorageGb(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "Unknown";
  return `${num.toFixed(num >= 10 ? 1 : 2)} GB`;
}

function formatBytes(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return "Unknown";
  if (num >= 1024 ** 3) return `${(num / (1024 ** 3)).toFixed(1)} GB`;
  if (num >= 1024 ** 2) return `${(num / (1024 ** 2)).toFixed(1)} MB`;
  if (num >= 1024) return `${(num / 1024).toFixed(1)} KB`;
  return `${Math.round(num)} B`;
}

function formatDate(value) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleTimeString();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  const data = text ? safeParseJson(text) : null;
  if (!response.ok) {
    const errorText = data?.error || data?.message || `${response.status} ${response.statusText}`;
    throw new Error(String(errorText));
  }
  return data;
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

window.addEventListener("beforeunload", () => {
  if (refreshTimer) window.clearInterval(refreshTimer);
});
