import { escapeHtml } from "./store.js";

const els = {
  logoutBtn: document.getElementById("logoutBtn"),
  refreshStatus: document.getElementById("datasetsRefreshStatus"),
  refreshBtn: document.getElementById("refreshDatasetsBtn"),
  overviewGrid: document.getElementById("datasetsOverviewGrid"),
  filterInput: document.getElementById("datasetsFilterInput"),
  sortSelect: document.getElementById("datasetsSortSelect"),
  list: document.getElementById("datasetsList"),
  detail: document.getElementById("datasetsDetail"),
  modal: document.getElementById("datasetsActionModal"),
  modalDialog: document.querySelector("#datasetsActionModal .datasets-modal-dialog"),
  modalTitle: document.getElementById("datasetsModalTitle"),
  modalCopy: document.getElementById("datasetsModalCopy"),
  modalCancel: document.getElementById("datasetsModalCancel"),
  modalConfirm: document.getElementById("datasetsModalConfirm"),
  modalClose: document.querySelector("#datasetsActionModal [data-modal-close]")
};

const state = {
  summaries: [],
  storage: { sessions_size_gb: 0, session_count: 0, free_disk_bytes: null },
  selectedSessionId: "",
  selectedDeviceId: "",
  dataMode: "exports",
  previewMode: "",
  renameSessionId: "",
  renameValue: "",
  filter: "",
  sortBy: "updated_desc",
  manifest: null,
  meta: null,
  sync: null,
  flash: null,
  loadingOverview: false,
  loadingDetail: false,
  actionBusy: "",
  lastRefreshAtMs: 0,
  detailSignature: ""
};

let overviewRequestToken = 0;
let detailRequestToken = 0;
let modalState = null;

init();

function init() {
  bindUi();
  syncSelectionFromUrl();
  renderOverview();
  renderList();
  renderDetail();
  void refreshAll();
}

function bindUi() {
  els.logoutBtn?.addEventListener("click", async () => {
    try {
      await fetch("/api/dashboard/logout", { method: "POST" });
    } catch {}
    window.location.assign("/dashboard/login");
  });

  els.refreshBtn?.addEventListener("click", () => {
    void refreshAll({ forceFlash: { tone: "info", message: "Refreshing..." } });
  });

  els.filterInput?.addEventListener("input", () => {
    state.filter = String(els.filterInput.value || "").trim().toLowerCase();
    renderList();
  });

  els.sortSelect?.addEventListener("change", () => {
    state.sortBy = String(els.sortSelect.value || "updated_desc");
    renderList();
  });

  els.modalCancel?.addEventListener("click", () => {
    closeActionModal(null);
  });

  els.modalClose?.addEventListener("click", () => {
    closeActionModal(null);
  });

  els.modalConfirm?.addEventListener("click", () => {
    submitActionModal();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !els.modal?.hidden) closeActionModal(null);
  });
}

async function refreshAll({ forceFlash = null, background = false } = {}) {
  if (forceFlash) {
    state.flash = forceFlash;
    renderDetail();
  }
  await loadOverview();
  await loadSelectedDetail({ background: background && !forceFlash });
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
    state.flash = { tone: "error", message: `Refresh failed: ${String(error.message || error)}` };
  } finally {
    if (token === overviewRequestToken) {
      state.loadingOverview = false;
      renderOverview();
      renderList();
      updateRefreshStatus();
    }
  }
}

async function loadSelectedDetail({ background = false } = {}) {
  const selected = getSelectedSummary();
  if (!selected) {
    const hadDetail = !!(state.manifest || state.meta || state.sync || state.detailSignature);
    state.manifest = null;
    state.meta = null;
    state.sync = null;
    state.loadingDetail = false;
    state.detailSignature = "";
    if (hadDetail) renderDetail();
    return;
  }

  const token = ++detailRequestToken;
  const previousSignature = state.detailSignature;
  let shouldRender = !background;
  if (!background) {
    state.loadingDetail = true;
    renderDetail();
  }

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
      shouldRender = true;
    }
    state.detailSignature = buildDetailSignature(selected, manifest, meta, sync, state.selectedDeviceId);
    if (state.detailSignature !== previousSignature) shouldRender = true;
  } catch (error) {
    if (token !== detailRequestToken) return;
    state.manifest = null;
    state.meta = null;
    state.sync = null;
    state.flash = { tone: "error", message: `Load failed: ${String(error.message || error)}` };
    state.detailSignature = "";
    shouldRender = true;
  } finally {
    if (token === detailRequestToken) {
      state.loadingDetail = false;
      if (shouldRender) renderDetail();
    }
  }
}

function normalizeSelection() {
  const ids = state.summaries.map((summary) => summary.id);
  if (state.renameSessionId && !ids.includes(state.renameSessionId)) {
    state.renameSessionId = "";
    state.renameValue = "";
  }
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
    els.refreshStatus.textContent = "Refreshing...";
    return;
  }
  if (!state.lastRefreshAtMs) return;
  els.refreshStatus.textContent = `Updated ${formatTime(state.lastRefreshAtMs)}`;
}

function renderOverview() {
  if (!els.overviewGrid) return;
  const cards = [
    {
      label: "Sessions",
      value: String(state.storage?.session_count ?? state.summaries.length ?? 0),
      hint: ""
    },
    {
      label: "Used",
      value: formatStorageGb(state.storage?.sessions_size_gb),
      hint: ""
    },
    {
      label: "Free",
      value: formatBytes(state.storage?.free_disk_bytes),
      hint: ""
    }
  ];

  els.overviewGrid.innerHTML = cards.map((card) => `
    <article class="status-card datasets-overview-card">
      <span class="status-label">${escapeHtml(card.label)}</span>
      <div class="status-value">
        <span class="status-text">${escapeHtml(card.value)}</span>
      </div>
      ${card.hint ? `<p class="datasets-overview-hint">${escapeHtml(card.hint)}</p>` : ""}
    </article>
  `).join("");
}

function renderList() {
  if (!els.list) return;
  const filtered = sortDatasetSummaries(
    state.summaries.filter((summary) => datasetMatchesFilter(summary, state.filter)),
    state.sortBy
  );
  if (!filtered.length) {
    els.list.innerHTML = `
      <div class="datasets-empty">
        <strong>${state.filter ? "No matches" : "No sessions"}</strong>
      </div>
    `;
    return;
  }

  els.list.innerHTML = filtered.map((summary) => {
    const active = summary.id === state.selectedSessionId;
    const editing = summary.id === state.renameSessionId;
    const title = formatSessionTitle(summary);
    const deviceCount = summary.device_count || Object.keys(summary.device_names || {}).length || 0;
    const metaParts = [
      formatDate(summary.created_at_iso),
      `${deviceCount} device${deviceCount === 1 ? "" : "s"}`,
      formatBytes(summary.session_size_bytes),
      formatDuration(summary.duration_ms)
    ];
    if (summary.active) metaParts.push("Live");
    return `
      <div class="datasets-list-row">
        ${editing
          ? `
            <div class="datasets-list-item${active ? " is-active" : ""} is-editing">
              <div class="datasets-list-head">
                <label class="datasets-inline-name-field">
                  <input
                    type="text"
                    class="datasets-inline-name-input"
                    data-rename-input-id="${escapeHtml(summary.id)}"
                    data-session-title="${escapeHtml(title)}"
                    value="${escapeHtml(state.renameValue || title)}"
                    aria-label="Rename ${escapeHtml(title)}"
                    maxlength="120"
                  />
                </label>
              </div>
              <div class="datasets-list-meta">${escapeHtml(metaParts.join(" · "))}</div>
            </div>
          `
          : `
            <button type="button" class="datasets-list-item${active ? " is-active" : ""}" data-session-id="${escapeHtml(summary.id)}">
              <div class="datasets-list-head">
                <strong>${escapeHtml(title)}</strong>
              </div>
              <div class="datasets-list-meta">${escapeHtml(metaParts.join(" · "))}</div>
            </button>
          `}
        <div class="datasets-list-actions">
          <button
            type="button"
            class="datasets-list-rename${editing ? " is-submit" : ""}"
            data-rename-session-id="${escapeHtml(summary.id)}"
            data-session-title="${escapeHtml(title)}"
            aria-label="${editing ? `Save ${escapeHtml(title)}` : `Rename ${escapeHtml(title)}`}"
            title="${editing ? "Save" : "Rename"}"
            ${state.actionBusy ? " disabled" : ""}
          ><span aria-hidden="true">${editing ? "&#10003;" : "&#9998;"}</span></button>
          <button
            type="button"
            class="datasets-list-delete"
            data-delete-session-id="${escapeHtml(summary.id)}"
            aria-label="Delete ${escapeHtml(title)}"
            title="Delete"
            ${state.actionBusy ? " disabled" : ""}
          ><span aria-hidden="true">&#128465;</span></button>
        </div>
      </div>
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

  for (const button of els.list.querySelectorAll("[data-delete-session-id]")) {
    button.addEventListener("click", () => {
      const sessionId = String(button.getAttribute("data-delete-session-id") || "");
      if (!sessionId) return;
      void handleDeleteDataset(sessionId);
    });
  }

  for (const button of els.list.querySelectorAll("[data-rename-session-id]")) {
    button.addEventListener("click", () => {
      const sessionId = String(button.getAttribute("data-rename-session-id") || "");
      const sessionTitle = String(button.getAttribute("data-session-title") || "");
      if (!sessionId) return;
      if (state.renameSessionId === sessionId) {
        void handleRenameDataset(sessionId, sessionTitle);
        return;
      }
      startInlineRename(sessionId, sessionTitle);
    });
  }

  for (const input of els.list.querySelectorAll("[data-rename-input-id]")) {
    input.addEventListener("click", (event) => {
      event.stopPropagation();
    });
    input.addEventListener("input", () => {
      state.renameValue = String(input.value || "");
    });
    input.addEventListener("keydown", (event) => {
      const sessionId = String(input.getAttribute("data-rename-input-id") || "");
      const currentTitle = String(input.getAttribute("data-session-title") || "");
      if (event.key === "Enter") {
        event.preventDefault();
        void handleRenameDataset(sessionId, currentTitle);
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelInlineRename();
      }
    });
  }

  const activeRenameInput = els.list.querySelector("[data-rename-input-id]");
  if (activeRenameInput) {
    window.setTimeout(() => {
      activeRenameInput.focus();
      activeRenameInput.select();
    }, 0);
  }
}

function renderDetail() {
  if (!els.detail) return;
  const summary = getSelectedSummary();
  if (!summary) {
    els.detail.innerHTML = `
      <div class="datasets-empty datasets-detail-empty">
        <strong>No session</strong>
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
  const previewOptions = buildPreviewOptions(manifest);
  const previewOption = resolvePreviewOption(previewOptions);
  const previewUrl = previewOption?.href || "";
  const detailMetrics = buildDetailMetrics(summary, manifest, meta, sync);
  const exportLinks = buildExportLinks(manifest);
  const rawLinks = buildRawLinks(manifest);
  const deviceOptions = buildDeviceOptions(summary, manifest);
  const hasMultipleDevices = deviceOptions.length > 1;
  const selectedDeviceName = selectedDeviceId ? formatDeviceName(summary, selectedDeviceId) : "";
  const dataMode = resolveDataMode(exportLinks, rawLinks);
  const dataLinks = dataMode === "exports" ? exportLinks : rawLinks;
  const dataNameLabel = dataMode === "exports" ? "Export" : "File";
  const dataEmpty = dataMode === "exports" ? "No exports." : "No raw data.";
  const dataMeta = dataMode === "exports"
    ? `${exportLinks.length} file${exportLinks.length === 1 ? "" : "s"}`
    : (selectedDeviceName || `${rawLinks.length} item${rawLinks.length === 1 ? "" : "s"}`);
  const previewState = capturePreviewState();

  els.detail.innerHTML = `
    <div class="datasets-detail-head">
      <div class="datasets-detail-copy">
        <h2>${escapeHtml(formatSessionTitle(summary))}</h2>
      </div>
      <div class="datasets-detail-actions">
        <button type="button" class="btn btn-alt btn-small" data-action="generate-exports"${state.actionBusy ? " disabled" : ""}>Build Exports</button>
      </div>
    </div>

    ${state.flash ? `<div class="datasets-flash is-${escapeHtml(state.flash.tone || "info")}">${escapeHtml(state.flash.message || "")}</div>` : ""}
    ${state.loadingDetail ? '<div class="datasets-flash is-info">Loading...</div>' : ""}

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
        <div class="datasets-panel-head datasets-preview-head">
          <div class="datasets-data-head-main">
            <h3>Preview</h3>
            <span class="datasets-panel-meta">${escapeHtml(previewUrl ? "Ready" : "Pending")}</span>
          </div>
          <div class="datasets-preview-controls">
            <label class="datasets-preview-control">
              <span class="datasets-control-label">View</span>
              <select data-preview-mode ${previewOptions.length ? "" : "disabled"}>
                ${previewOptions.length
                  ? previewOptions.map((option) => `
                    <option value="${escapeHtml(option.value)}"${option.value === previewOption?.value ? " selected" : ""}>
                      ${escapeHtml(option.label)}
                    </option>
                  `).join("")
                  : '<option value="">No preview</option>'}
              </select>
            </label>
            <label class="datasets-preview-control">
              <span class="datasets-control-label">Perspective</span>
              ${previewOption?.scope === "device"
                ? `
                  <select data-preview-device>
                    ${deviceOptions.map((device) => `
                      <option value="${escapeHtml(device.deviceId)}"${device.deviceId === selectedDeviceId ? " selected" : ""}>
                        ${escapeHtml(device.name)}
                      </option>
                    `).join("")}
                  </select>
                `
                : `
                  <select disabled>
                    <option>Session</option>
                  </select>
                `}
            </label>
          </div>
        </div>
        ${previewUrl
          ? `<video class="datasets-preview-video" controls playsinline preload="auto" src="${escapeHtml(previewUrl)}"></video>`
          : '<div class="datasets-preview-empty">No preview yet.</div>'}
      </section>

      <section class="datasets-panel datasets-data-panel">
        <div class="datasets-panel-head datasets-data-head">
          <div class="datasets-data-head-main">
            <h3>Data</h3>
            <span class="datasets-panel-meta">${escapeHtml(dataMeta)}</span>
          </div>
          <div class="datasets-data-controls">
            <div class="datasets-control-group">
              <span class="datasets-control-label">View</span>
              <div class="datasets-mode-tabs">
                <button
                  type="button"
                  class="datasets-mode-tab${dataMode === "exports" ? " is-active" : ""}"
                  data-data-mode="exports"
                >Exports</button>
                <button
                  type="button"
                  class="datasets-mode-tab${dataMode === "raw" ? " is-active" : ""}"
                  data-data-mode="raw"
                >Raw files</button>
              </div>
            </div>
            <div class="datasets-control-group">
              <span class="datasets-control-label">${dataMode === "exports" ? "Scope" : "Device"}</span>
              ${dataMode === "exports"
                ? '<div class="datasets-scope-pill">Session</div>'
                : `
                  <div class="datasets-device-tabs">
                    ${hasMultipleDevices
                      ? deviceOptions.map((device) => `
                        <button
                          type="button"
                          class="datasets-device-tab${device.deviceId === selectedDeviceId ? " is-active" : ""}"
                          data-device-id="${escapeHtml(device.deviceId)}"
                          title="${escapeHtml(device.deviceId)}"
                        >${escapeHtml(device.name)}</button>
                      `).join("")
                      : `<div class="datasets-scope-pill">${escapeHtml(selectedDeviceName || deviceOptions[0]?.name || "Device")}</div>`}
                  </div>
                `}
            </div>
          </div>
        </div>
        <div class="datasets-table-wrap">
          ${dataLinks.length
            ? renderLinkTable(dataLinks, { nameLabel: dataNameLabel })
            : `<div class="datasets-inline-empty">${escapeHtml(dataEmpty)}</div>`}
        </div>
      </section>
    </div>
  `;

  const exportBtn = els.detail.querySelector('[data-action="generate-exports"]');
  exportBtn?.addEventListener("click", () => {
    void handleGenerateExports(summary.id);
  });

  const previewModeSelect = els.detail.querySelector("[data-preview-mode]");
  previewModeSelect?.addEventListener("change", () => {
    state.previewMode = String(previewModeSelect.value || "").trim();
    renderDetail();
  });

  const previewDeviceSelect = els.detail.querySelector("[data-preview-device]");
  previewDeviceSelect?.addEventListener("change", () => {
    const nextDeviceId = String(previewDeviceSelect.value || "").trim();
    if (!nextDeviceId || nextDeviceId === state.selectedDeviceId) return;
    state.selectedDeviceId = nextDeviceId;
    syncSelectionToUrl();
    void loadSelectedDetail();
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

  for (const button of els.detail.querySelectorAll("[data-data-mode]")) {
    button.addEventListener("click", () => {
      const nextMode = String(button.getAttribute("data-data-mode") || "");
      if (!nextMode || nextMode === state.dataMode) return;
      state.dataMode = nextMode;
      renderDetail();
    });
  }

  const previewVideo = els.detail.querySelector(".datasets-preview-video");
  if (previewVideo) restorePreviewState(previewVideo, previewState, previewUrl);
}

async function handleGenerateExports(sessionId) {
  state.actionBusy = "exports";
  state.flash = { tone: "info", message: "Building..." };
  renderList();
  renderDetail();
  try {
    await fetchJson(`/api/datasets/${encodeURIComponent(sessionId)}/exports`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: true })
    });
    state.flash = { tone: "success", message: "Exports ready." };
    await refreshAll();
  } catch (error) {
    state.flash = { tone: "error", message: `Build failed: ${String(error.message || error)}` };
    renderDetail();
  } finally {
    state.actionBusy = "";
    renderList();
    renderDetail();
  }
}

async function handleRenameDataset(sessionId, currentTitle) {
  const sessionName = String(state.renameValue || currentTitle || "").trim();
  if (!sessionName || sessionName === currentTitle) {
    cancelInlineRename();
    return;
  }

  state.actionBusy = "rename";
  state.flash = { tone: "info", message: "Renaming..." };
  renderList();
  renderDetail();
  try {
    const result = await fetchJson(`/api/datasets/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_name: sessionName })
    });
    const nextSessionId = String(result?.id || sessionId);
    if (state.selectedSessionId === sessionId) {
      state.selectedSessionId = nextSessionId;
      syncSelectionToUrl();
    }
    state.renameSessionId = "";
    state.renameValue = "";
    state.flash = { tone: "success", message: "Renamed." };
    await loadOverview();
    await loadSelectedDetail();
  } catch (error) {
    state.flash = { tone: "error", message: `Rename failed: ${String(error.message || error)}` };
    renderDetail();
  } finally {
    state.actionBusy = "";
    renderList();
    renderDetail();
  }
}

async function handleDeleteDataset(sessionId) {
  const confirmed = await openActionModal({
    type: "delete",
    title: "Delete session?",
    copy: "This removes the session from disk.",
    confirmLabel: "Delete"
  });
  if (!confirmed) return;
  state.actionBusy = "delete";
  state.flash = { tone: "warn", message: `Deleting ${sessionId}...` };
  renderList();
  renderDetail();
  try {
    await fetchJson(`/api/datasets/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    state.flash = { tone: "success", message: `${sessionId} deleted.` };
    if (state.selectedSessionId === sessionId) {
      state.selectedSessionId = "";
      state.selectedDeviceId = "";
    }
    if (state.renameSessionId === sessionId) {
      state.renameSessionId = "";
      state.renameValue = "";
    }
    await loadOverview();
    await loadSelectedDetail();
  } catch (error) {
    state.flash = { tone: "error", message: `Delete failed: ${String(error.message || error)}` };
  } finally {
    state.actionBusy = "";
    renderList();
    renderDetail();
  }
}

function startInlineRename(sessionId, currentTitle) {
  state.renameSessionId = sessionId;
  state.renameValue = currentTitle;
  renderList();
}

function cancelInlineRename() {
  state.renameSessionId = "";
  state.renameValue = "";
  renderList();
}

function buildDetailMetrics(summary, manifest, meta, sync) {
  const requested = Array.isArray(summary.requested_modalities) && summary.requested_modalities.length
    ? summary.requested_modalities.map(formatModalityLabel).join(", ")
    : "-";
  const updatedAt = summary.updated_at_ms ? formatDate(summary.updated_at_ms) : "-";
  return [
    { label: "Updated", value: updatedAt },
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
    { label: "GPS Playback Video", href: exports.gpsPlaybackVideo, kind: "video" },
    { label: "GPS Playback Data", href: exports.gpsPlaybackJson, kind: "json" }
  ];
  return items.filter((item) => !!item.href);
}

function buildRawLinks(manifest) {
  if (!manifest) return [];
  return [
    pickPreferredLink("Motion", [
      { href: manifest.imuParquet, kind: "parquet" },
      { href: manifest.imuCsv, kind: "csv" }
    ]),
    pickPreferredLink("Location", [
      { href: manifest.gpsParquet, kind: "parquet" },
      { href: manifest.gpsCsv, kind: "csv" }
    ]),
    pickPreferredLink("Audio", [
      { href: manifest.audioWav, kind: "audio" },
      { href: manifest.audioParquet, kind: "parquet" },
      { href: manifest.audioCsv, kind: "csv" }
    ]),
    pickPreferredLink("Camera frames", [
      { href: manifest.cameraDir, kind: "dir" }
    ]),
    pickPreferredLink("Camera timestamps", [
      { href: manifest.cameraTimestampsCsv, kind: "csv" }
    ]),
    pickPreferredLink("Events", [
      { href: manifest.eventsParquet, kind: "parquet" },
      { href: manifest.eventsCsv, kind: "csv" }
    ]),
    pickPreferredLink("Device", [
      { href: manifest.deviceParquet, kind: "parquet" },
      { href: manifest.deviceCsv, kind: "csv" }
    ]),
    pickPreferredLink("Fusion", [
      { href: manifest.fusionParquet, kind: "parquet" },
      { href: manifest.fusionCsv, kind: "csv" }
    ]),
    pickPreferredLink("Network", [
      { href: manifest.netParquet, kind: "parquet" },
      { href: manifest.netCsv, kind: "csv" }
    ])
  ].filter(Boolean);
}

function buildPreviewOptions(manifest) {
  if (!manifest) return [];
  const exports = manifest.sessionExports || {};
  return [
    {
      value: "session_multiview_with_audio_and_gps",
      label: "Combined + map + audio",
      href: exports.multiviewWithAudioAndGps,
      scope: "session"
    },
    {
      value: "session_multiview_with_audio",
      label: "Combined + audio",
      href: exports.multiviewWithAudio,
      scope: "session"
    },
    {
      value: "session_multiview",
      label: "Combined",
      href: exports.multiview,
      scope: "session"
    },
    {
      value: "device_camera_with_audio",
      label: "Camera + audio",
      href: manifest.cameraWithAudio,
      scope: "device"
    },
    {
      value: "device_camera",
      label: "Camera only",
      href: manifest.cameraVideo,
      scope: "device"
    },
    {
      value: "session_gps_playback",
      label: "Map playback",
      href: exports.gpsPlaybackVideo,
      scope: "session"
    }
  ].filter((option) => !!option.href);
}

function buildDeviceOptions(summary, manifest) {
  const ids = getAvailableDeviceIds(summary, manifest, null, null);
  return ids.map((deviceId) => {
    return {
      deviceId,
      name: formatDeviceName(summary, deviceId)
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

function sortDatasetSummaries(summaries, sortBy) {
  const list = [...summaries];
  list.sort((a, b) => {
    if (sortBy === "updated_asc") return compareSummaryTime(a, b) || compareSummaryTitle(a, b);
    if (sortBy === "name_asc") return compareSummaryTitle(a, b) || compareSummaryTime(b, a);
    if (sortBy === "name_desc") return compareSummaryTitle(b, a) || compareSummaryTime(b, a);
    if (sortBy === "size_desc") return compareSummaryNumber(b?.session_size_bytes, a?.session_size_bytes) || compareSummaryTitle(a, b);
    if (sortBy === "duration_desc") return compareSummaryNumber(b?.duration_ms, a?.duration_ms) || compareSummaryTitle(a, b);
    return compareSummaryTime(b, a) || compareSummaryTitle(a, b);
  });
  return list;
}

function compareSummaryTitle(a, b) {
  return formatSessionTitle(a).localeCompare(formatSessionTitle(b), undefined, {
    sensitivity: "base",
    numeric: true
  });
}

function compareSummaryTime(a, b) {
  return compareSummaryNumber(getSummaryTimeMs(a), getSummaryTimeMs(b));
}

function compareSummaryNumber(a, b) {
  return Number(a || 0) - Number(b || 0);
}

function getSummaryTimeMs(summary) {
  const updatedMs = Number(summary?.updated_at_ms || 0);
  if (Number.isFinite(updatedMs) && updatedMs > 0) return updatedMs;
  const createdMs = new Date(summary?.created_at_iso || "").getTime();
  return Number.isFinite(createdMs) && createdMs > 0 ? createdMs : 0;
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

function resolvePreviewOption(options) {
  if (!options.length) return null;
  const preferred = options.find((option) => option.value === state.previewMode);
  return preferred || options[0];
}

function renderLinkTable(links, { nameLabel = "Name" } = {}) {
  return `
    <table class="datasets-link-table">
      <thead>
        <tr>
          <th scope="col">${escapeHtml(nameLabel)}</th>
          <th scope="col">Type</th>
          <th scope="col">View</th>
          <th scope="col">Download</th>
        </tr>
      </thead>
      <tbody>
        ${links.map((link) => `
          <tr>
            <td>${escapeHtml(link.label)}</td>
            <td>${escapeHtml(link.kind.toUpperCase())}</td>
            <td><a class="datasets-link-action" href="${escapeHtml(link.href)}" target="_blank" rel="noreferrer noopener">View</a></td>
            <td>${link.kind === "dir"
              ? '<span class="datasets-link-muted">-</span>'
              : `<a class="datasets-link-action" href="${escapeHtml(link.href)}" download>Download</a>`}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function openActionModal({ type = "confirm", title = "Confirm", copy = "", confirmLabel = "Confirm" } = {}) {
  if (!els.modal) return Promise.resolve(null);
  closeActionModal(null);
  modalState = { type, resolve: null };
  els.modalTitle.textContent = title;
  els.modalCopy.textContent = copy;
  els.modalConfirm.textContent = confirmLabel;
  els.modalConfirm.classList.toggle("datasets-modal-danger", type === "delete");
  els.modalDialog?.classList.toggle("is-danger", type === "delete");
  els.modal.hidden = false;
  const scrollbarWidth = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
  document.body.style.paddingRight = scrollbarWidth > 0 ? `${scrollbarWidth}px` : "";
  document.body.classList.add("phone-modal-open");
  window.setTimeout(() => {
    els.modalConfirm.focus();
  }, 0);
  return new Promise((resolve) => {
    modalState.resolve = resolve;
  });
}

function closeActionModal(result) {
  if (!els.modal || els.modal.hidden) {
    if (modalState?.resolve) modalState.resolve(result);
    modalState = null;
    return;
  }
  const resolve = modalState?.resolve || null;
  els.modal.hidden = true;
  els.modalConfirm.classList.remove("datasets-modal-danger");
  els.modalDialog?.classList.remove("is-danger");
  document.body.classList.remove("phone-modal-open");
  document.body.style.paddingRight = "";
  modalState = null;
  if (resolve) resolve(result);
}

function submitActionModal() {
  if (!modalState) return;
  closeActionModal(true);
}

function pickPreferredLink(label, candidates) {
  const match = candidates.find((candidate) => !!candidate.href);
  if (!match) return null;
  return { label, href: match.href, kind: match.kind };
}

function resolveDataMode(exportLinks, rawLinks) {
  if (state.dataMode === "raw" && rawLinks.length) return "raw";
  if (state.dataMode === "exports" && exportLinks.length) return "exports";
  if (exportLinks.length) return "exports";
  if (rawLinks.length) return "raw";
  return "exports";
}

function buildDetailSignature(summary, manifest, meta, sync, selectedDeviceId) {
  return JSON.stringify({
    sessionId: summary?.id || "",
    sessionName: summary?.session_name || "",
    selectedDeviceId: selectedDeviceId || "",
    updatedAt: summary?.updated_at_ms || "",
    durationMs: summary?.duration_ms || 0,
    sessionSizeBytes: summary?.session_size_bytes || 0,
    exportCount: summary?.export_count || 0,
    deviceCount: summary?.device_count || 0,
    active: !!summary?.active,
    requested: summary?.requested_modalities || [],
    previewOptions: buildPreviewOptions(manifest),
    exportLinks: buildExportLinks(manifest),
    rawLinks: buildRawLinks(manifest),
    availableDeviceIds: getAvailableDeviceIds(summary, manifest, meta, sync),
    metaDevices: meta?.devices || {},
    syncDevices: sync?.devices || {}
  });
}

function capturePreviewState() {
  const video = els.detail?.querySelector(".datasets-preview-video");
  if (!video) return null;
  return {
    src: video.currentSrc || video.getAttribute("src") || "",
    currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
    paused: video.paused,
    ended: video.ended
  };
}

function restorePreviewState(video, previewState, previewUrl) {
  if (!previewState || !previewUrl || previewState.src !== previewUrl) return;
  const apply = () => {
    if (previewState.currentTime > 0) {
      try {
        video.currentTime = previewState.currentTime;
      } catch {}
    }
    if (!previewState.paused && !previewState.ended) {
      const playPromise = video.play();
      if (playPromise && typeof playPromise.catch === "function") playPromise.catch(() => {});
    }
  };
  if (video.readyState >= 1) apply();
  else video.addEventListener("loadedmetadata", apply, { once: true });
}

function formatDeviceName(summary, deviceId) {
  return summary.device_names?.[deviceId] || deviceId;
}

function formatSessionTitle(summary) {
  const sessionName = String(summary?.session_name || "").trim();
  const sessionId = String(summary?.id || "").trim();
  if (sessionName && sessionName !== sessionId) return sessionName;
  return formatSessionLabel(sessionId);
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
  return date.toLocaleString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  });
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  });
}

function formatDuration(value) {
  const totalSec = Math.max(0, Math.round(Number(value || 0) / 1000));
  if (!Number.isFinite(totalSec) || totalSec <= 0) return "-";
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
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
