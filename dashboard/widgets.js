import { escapeHtml, formatElapsed, formatTs, parseImuCsv, parseCameraTsCsv, parseEventsCsv } from "./store.js";

export function deviceSettingSchema() {
  return { key: "device_id", type: "device", label: "Device" };
}

export function getWidgetDevice(settings) {
  const val = settings?.device_id;
  if (val && val !== "global") return val;
  return "";
}

const GPS_LIVE_TILE_SIZE = 256;
const GPS_LIVE_TILE_TEMPLATE = "https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png";
const GPS_LIVE_STALE_MS = 15000;
const GPS_LIVE_TRAIL_MAX_AGE_MS = 20 * 60 * 1000;
const GPS_LIVE_TRAIL_MAX_POINTS = 2400;
const GPS_LIVE_DRAW_MAX_POINTS = 700;
const GPS_LIVE_COLORS = ["#ff6b6b", "#4dabf7", "#51cf66", "#fcc419", "#b197fc", "#63e6be", "#ffa94d", "#f783ac"];
const gpsLiveTrailCache = new Map();
const gpsLiveTileCache = new Map();

export function createWidgetRegistry({ store, bus, previewRtc, sendJson, mergeRunConfig, defaultRunConfig, loadReplaySessions }) {
  return {
    fleet_health: {
      title: "Fleet Health",
      defaults: { w: 6, h: 2, pinned: true, settings: { device_id: "global" } },
      settingsSchema: [deviceSettingSchema()],
      render(content, ctx) {
        const box = document.createElement("div");
        box.className = "kv-grid";
        content.appendChild(box);
        const unsub = store.subscribe((s) => ({ list: s.deviceList, states: s.statesByDevice, rec: s.recording }), () => render(box, ctx));
        render(box, ctx);
        return () => unsub();
      }
    },


    fleet_sensor_matrix: {
      title: "Fleet Sensor Matrix",
      defaults: { w: 12, h: 3, pinned: true, settings: {} },
      render(content) {
        const table = document.createElement("table");
        table.className = "fleet-matrix";
        table.innerHTML = "<thead><tr><th>Device</th><th>IMU</th><th>GPS</th><th>Audio</th><th>Camera</th></tr></thead><tbody></tbody>";
        const tbody = table.querySelector("tbody");
        content.appendChild(table);

        const unsub = store.subscribe((s) => ({ list: s.deviceList, states: s.statesByDevice }), () => {
          const st = store.getState();
          tbody.innerHTML = "";
          for (const d of st.deviceList || []) {
            const s = st.statesByDevice?.[d.device_id] || {};
            const imu = Number(d.imuHz ?? d.imu_hz ?? s.net?.imu_hz ?? 0);
            const cam = Number(d.camFps ?? d.cameraFps ?? d.camera_fps ?? s.net?.camera_fps ?? 0);
            const camLive = !!d.cameraPreviewLive;
            const gps = s.gps_latest;
            const audio = s.audio_latest;

            const imuTxt = imu > 0 ? `${imu.toFixed(1)} Hz` : "idle";
            const gpsTxt = gps ? `${Number(gps.lat).toFixed(5)}, ${Number(gps.lon).toFixed(5)}` : "no fix";
            const audTxt = audio ? `${Math.round(20 * Math.log10(Math.max(1e-6, Number(audio.amplitude || 0))))} dB` : "idle";
            const camTxt = cam > 0 ? `${cam.toFixed(1)} FPS` : (camLive ? "WebRTC live" : "idle");

            const tr = document.createElement("tr");
            tr.innerHTML = `<td>${escapeHtml(String(d.deviceName || d.device_id))}<div class="device-sub">${escapeHtml(d.device_id)}</div></td><td>${escapeHtml(imuTxt)}</td><td>${escapeHtml(gpsTxt)}</td><td>${escapeHtml(audTxt)}</td><td>${escapeHtml(camTxt)}</td>`;
            tbody.appendChild(tr);
          }
        });

        return () => unsub();
      }
    },
    device_list: {
      title: "Connected Phones",
      defaults: { w: 3, h: 5, pinned: true, settings: {} },
      render(content) {
        const list = document.createElement("div");
        list.className = "device-roster";
        content.appendChild(list);
        const pendingKicks = new Set();

        const unsub = store.subscribe((s) => ({ list: s.deviceList, states: s.statesByDevice }), () => {
          const st = store.getState();
          list.innerHTML = "";
          const activeIds = new Set();
          if (!st.deviceList || !st.deviceList.length) {
            const empty = document.createElement("div");
            empty.className = "empty-state device-roster-empty";
            empty.textContent = "No phones connected";
            list.appendChild(empty);
            return;
          }
          for (const d of st.deviceList) {
            activeIds.add(String(d.device_id || ""));
            const imu = Number(d.imuHz ?? d.imu_hz ?? 0);
            const cam = Number(d.camFps ?? d.cameraFps ?? d.camera_fps ?? 0);
            const connected = d?.connected !== false;
            const streaming = connected && (imu > 0.5 || cam > 0.5 || !!d.cameraPreviewLive);
            const tone = connected ? (streaming ? "ok" : "warn") : "bad";
            const label = tone === "ok" ? "Streaming" : tone === "warn" ? "Idle" : "Disconnected";

            const readiness = connected ? (d.recordingActive ? "recording" : "armed") : "not ready";
            const readinessClass = readiness === "recording" ? "recording" : (readiness === "armed" ? "armed" : "not-ready");
            const dropped = Number(d.droppedPackets ?? 0);
            const lastSeen = d.lastSeenTs ? formatTs(d.lastSeenTs) : "-";
            const displayName = escapeHtml(String(d.deviceName || d.device_id));
            const secondaryId = escapeHtml(String(d.device_id));
            const now = Date.now();
            const deviceState = st.statesByDevice?.[d.device_id] || {};
            const gpsLatest = deviceState.gps_latest || null;
            const gpsStream = deviceState.stream_status?.gps || null;
            const gpsEnabled = !!gpsStream?.enabled;
            const gpsLastSeen = Number(gpsLatest?.t_recv_ms || gpsStream?.last_seen_ms || 0);
            const gpsAgeMs = gpsLastSeen ? (now - gpsLastSeen) : Number.POSITIVE_INFINITY;
            const gpsAccuracy = Number(gpsLatest?.accuracy_m);
            let gpsClass = "off";
            let gpsText = "off";
            if (!connected) {
              gpsClass = "offline";
              gpsText = "offline";
            } else if (!gpsEnabled) {
              gpsClass = "off";
              gpsText = "off";
            } else if (!gpsLastSeen) {
              gpsClass = "warn";
              gpsText = "no fix";
            } else if (gpsAgeMs <= 5000) {
              gpsClass = "ok";
              gpsText = Number.isFinite(gpsAccuracy) && gpsAccuracy >= 0 ? `live (${Math.round(gpsAccuracy)}m)` : "live";
            } else if (gpsAgeMs <= 15000) {
              gpsClass = "warn";
              gpsText = `stale (${Math.round(gpsAgeMs / 1000)}s)`;
            } else {
              gpsClass = "bad";
              gpsText = "signal lost";
            }
            const healthAlerts = Array.isArray(d.healthAlerts) ? d.healthAlerts : [];
            const hasError = healthAlerts.some((a) => String(a?.severity || "").toLowerCase() === "error");
            const healthClass = !connected ? "bad" : (healthAlerts.length ? (hasError ? "bad" : "warn") : "ok");
            const healthText = !connected
              ? "offline"
              : (healthAlerts.length ? `${healthAlerts.length} alert${healthAlerts.length > 1 ? "s" : ""}` : "ok");
            const healthTitle = healthAlerts.length
              ? healthAlerts.map((a) => String(a?.message || a?.code || "alert")).join(" | ")
              : "No active alerts";
            const pendingKick = pendingKicks.has(d.device_id);
            const card = document.createElement("article");
            card.className = `device-roster-card tone-${tone}`;
            card.innerHTML = `
              <div class="device-roster-head">
                <div class="device-roster-title">
                  <span class="device-dot ${tone}"></span>
                  <div class="device-cell">
                    <div class="device-main">${displayName}</div>
                    <div class="device-sub">${secondaryId}</div>
                  </div>
                </div>
                <div class="device-roster-badges">
                  <span class="readiness-badge ${readinessClass}">${escapeHtml(readiness)}</span>
                  <span class="health-badge ${healthClass}" title="${escapeHtml(healthTitle)}">${escapeHtml(healthText)}</span>
                </div>
              </div>
              <div class="device-roster-grid">
                <div class="device-roster-metric">
                  <span class="device-roster-label">Status</span>
                  <strong>${escapeHtml(label)}</strong>
                </div>
                <div class="device-roster-metric">
                  <span class="device-roster-label">Motion</span>
                  <strong>${escapeHtml(`${imu.toFixed(1)} Hz`)}</strong>
                </div>
                <div class="device-roster-metric">
                  <span class="device-roster-label">Camera</span>
                  <strong>${escapeHtml(cam > 0 ? `${cam.toFixed(1)} FPS` : (d.cameraPreviewLive ? "RTC live" : "Off"))}</strong>
                </div>
                <div class="device-roster-metric">
                  <span class="device-roster-label">Location</span>
                  <strong><span class="gps-badge ${gpsClass}">${escapeHtml(gpsText)}</span></strong>
                </div>
                <div class="device-roster-metric">
                  <span class="device-roster-label">Dropouts</span>
                  <strong>${escapeHtml(Number.isFinite(dropped) ? String(dropped) : "-")}</strong>
                </div>
                <div class="device-roster-metric">
                  <span class="device-roster-label">Last seen</span>
                  <strong>${escapeHtml(lastSeen)}</strong>
                </div>
              </div>
            `;
            if (connected) {
              const actions = document.createElement("div");
              actions.className = "device-roster-actions";
              const kickBtn = document.createElement("button");
              kickBtn.type = "button";
              kickBtn.className = "btn btn-alt btn-small";
              kickBtn.textContent = pendingKick ? "Removing..." : "Kick";
              kickBtn.disabled = pendingKick;
              kickBtn.addEventListener("click", () => {
                if (pendingKicks.has(d.device_id)) return;
                const confirmed = window.confirm(`Disconnect ${String(d.deviceName || d.device_id)} from this session?`);
                if (!confirmed) return;
                pendingKicks.add(d.device_id);
                sendJson({ type: "device_kick", device_id: d.device_id });
                kickBtn.textContent = "Removing...";
                kickBtn.disabled = true;
              });
              actions.appendChild(kickBtn);
              card.appendChild(actions);
            }
            list.appendChild(card);
          }
          for (const deviceId of [...pendingKicks]) {
            if (!activeIds.has(deviceId)) pendingKicks.delete(deviceId);
          }
        });
        return () => unsub();
      }
    },

    stream_controls: {
      title: "Session Control",
      defaults: { w: 5, h: 6, pinned: true, settings: {} },
      render(content) {
        content.classList.add("session-setup-panel");

        const estimatePanel = document.createElement("section");
        estimatePanel.className = "session-estimate-panel";

        const capturePanel = document.createElement("section");
        capturePanel.className = "session-capture-panel";
        const captureTitle = document.createElement("div");
        captureTitle.className = "session-section-title";
        captureTitle.textContent = "Record";
        const captureGrid = document.createElement("div");
        captureGrid.className = "session-capture-grid";
        capturePanel.append(captureTitle, captureGrid);

        const recRow = document.createElement("div");
        recRow.className = "row session-cta-row";
        const ctaPanel = document.createElement("div");
        ctaPanel.className = "session-cta-panel";
        const ctaTitle = document.createElement("strong");
        ctaTitle.className = "session-cta-title";
        ctaTitle.textContent = "Recording";
        let actionPending = false;
        const ctaBtn = mkBtn("Start Recording", () => {
          actionPending = true;
          const st = store.getState();
          const isActiveNow = (st.sessionState || "draft") === "active" || !!st.recording?.active;
          if (isActiveNow) {
            sendJson({ type: "session_stop", session_id: st.recording?.session_id || null });
          } else {
            sendJson({
              type: "session_start",
              session_name: `session_${new Date().toISOString().replace(/[:.]/g, "-")}`
            });
          }
        }, "btn-success");
        ctaBtn.classList.add("primary", "large");
        ctaBtn.innerHTML = `
          <span class="button-text">Start Recording</span>
          <span class="button-spinner" hidden>Working...</span>
        `;
        const timer = document.createElement("span");
        timer.className = "session-rec-timer mono";
        timer.textContent = "0:00:00 elapsed";
        recRow.append(ctaBtn, timer);
        ctaPanel.append(ctaTitle, recRow);

        const setupDetails = document.createElement("details");
        setupDetails.className = "session-setup";
        const setupSummary = document.createElement("summary");
        setupSummary.innerHTML = `
          <div>
            <h2>Advanced</h2>
            <span class="helper">Join code and stream rates</span>
          </div>
        `;
        const setupBody = document.createElement("div");
        setupBody.className = "setup-content";
        setupDetails.append(setupSummary, setupBody);

        const form = document.createElement("div");
        form.className = "session-form";

        setupBody.append(form);

        const joinBanner = document.createElement("div");
        joinBanner.className = "join-code-banner";
        const joinBannerLeft = document.createElement("div");
        joinBannerLeft.className = "join-banner-left";
        const joinBannerLabel = document.createElement("span");
        joinBannerLabel.className = "join-banner-label";
        joinBannerLabel.textContent = "Join Code";
        const joinBannerCode = document.createElement("span");
        joinBannerCode.className = "join-banner-code mono";
        joinBannerCode.textContent = "——";
        joinBannerLeft.append(joinBannerLabel, joinBannerCode);
        const joinBannerRight = document.createElement("div");
        joinBannerRight.className = "join-banner-right";
        const joinBannerCopy = document.createElement("button");
        joinBannerCopy.className = "btn btn-alt";
        joinBannerCopy.textContent = "Copy";
        const joinBannerCopyLink = document.createElement("button");
        joinBannerCopyLink.className = "btn btn-alt";
        joinBannerCopyLink.textContent = "Copy Link";
        const setBannerCopyState = (button, idleLabel, activeLabel) => {
          button.textContent = activeLabel;
          setTimeout(() => {
            button.textContent = idleLabel;
          }, 1500);
        };
        joinBannerCopy.addEventListener("click", () => {
          const code = store.getState().sessionJoinCode;
          if (code) navigator.clipboard?.writeText(code).catch(() => {});
          setBannerCopyState(joinBannerCopy, "Copy", "Copied!");
        });
        joinBannerCopyLink.addEventListener("click", () => {
          const st = store.getState();
          const code = String(st.sessionJoinCode || "").trim();
          if (!code) return;
          const baseUrl = String(st.runtime?.public_url || window.location.origin || "").trim() || window.location.origin;
          const phoneUrl = new URL("/phone", baseUrl);
          phoneUrl.searchParams.set("join_code", code);
          navigator.clipboard?.writeText(phoneUrl.toString()).catch(() => {});
          setBannerCopyState(joinBannerCopyLink, "Copy Link", "Link Copied!");
        });
        joinBannerRight.append(joinBannerCopy, joinBannerCopyLink);
        joinBanner.append(joinBannerLeft, joinBannerRight);

        content.append(estimatePanel, joinBanner, ctaPanel, capturePanel, setupDetails);

        setupDetails.open = false;
        let prevIsActive = false;
        let lastFormKey = "";
        const pendingCaptureToggles = new Map();
        const pendingCaptureTimers = new Map();

        function markCaptureTogglePending(key, nextEnabled) {
          pendingCaptureToggles.set(String(key || ""), !!nextEnabled);
          const existing = pendingCaptureTimers.get(key);
          if (existing) clearTimeout(existing);
          const timer = setTimeout(() => {
            pendingCaptureTimers.delete(key);
            pendingCaptureToggles.delete(key);
            onStateChange();
          }, 900);
          pendingCaptureTimers.set(key, timer);
          onStateChange();
        }

        const onStateChange = () => {
          const st = store.getState();
          const cfg = mergeRunConfig(st.sessionConfig || defaultRunConfig);
          const isActive = (st.sessionState || "draft") === "active" || !!st.recording?.active;
          const joinCode = String(st.sessionJoinCode || "");
          joinBannerCode.textContent = joinCode || "——";

          const online = (st.deviceList || []).filter((d) => d?.connected !== false).length;
          const estimates = computeSessionEstimates(cfg);
          const captureItems = describeCapturePlan(cfg);

          estimatePanel.innerHTML = `
            <div class="session-estimate-head">
              <span class="session-estimate-label">Estimated Data</span>
              <strong>${escapeHtml(`${estimates.storageMbPerMin.toFixed(1)} MB/min/device`)}</strong>
            </div>
            <div class="session-estimate-copy">${escapeHtml(`${captureItems.join(", ")} · ${estimates.bandwidthMbps.toFixed(2)} Mbps/device live`)}</div>
          `;

          renderPrimaryCaptureToggles(captureGrid, cfg, isActive, updateSessionCfg, pendingCaptureToggles, markCaptureTogglePending);

          const phase = st.recording?.phase || (isActive ? "RECORDING" : "IDLE");
          const isStopping = phase === "STOPPING";
          const buttonText = ctaBtn.querySelector(".button-text");
          const buttonSpinner = ctaBtn.querySelector(".button-spinner");
          ctaBtn.disabled = isStopping || actionPending || (!isActive && online === 0);
          if (buttonText) buttonText.textContent = isActive ? "Stop Recording" : "Start Recording";
          ctaBtn.className = isActive ? "btn btn-danger" : "btn btn-success";
          ctaBtn.classList.add("primary", "large");
          if (buttonText) buttonText.hidden = !!actionPending;
          if (buttonSpinner) buttonSpinner.hidden = !actionPending;
          if (isActive || isStopping || st.recording?.last_error || phase === "IDLE") actionPending = false;
          timer.textContent = isStopping
            ? "Stopping and saving files..."
            : (isActive ? `${formatElapsed(st.recording?.elapsed_sec || 0)} elapsed` : "0:00:00 elapsed");
          if (isActive && !prevIsActive) setupDetails.open = false;
          prevIsActive = isActive;

          const formKey = JSON.stringify({
            active: isActive,
            imu_enabled: !!cfg.streams.imu.enabled,
            imu_rate: Number(cfg.streams.imu.rate_hz || 30),
            cam_enabled: String(cfg.streams.camera.mode || "off") !== "off",
            cam_mode: String(cfg.streams.camera.mode || "off"),
            cam_fps: Number(cfg.streams.camera.fps || 10),
            audio_enabled: !!cfg.streams.audio.enabled,
            audio_rate: Number(cfg.streams.audio.rate_hz || 10),
            gps_enabled: !!cfg.streams.gps.enabled,
            gps_rate: Number(cfg.streams.gps.rate_hz || 1),
            join_code: joinCode
          });
          if (formKey === lastFormKey) return;
          lastFormKey = formKey;

          form.innerHTML = "";

          const authBody = addFormSection(form, "Join Access", "Change the code that phones use to join this session.");
          addTextInput(authBody, "Join code", joinCode, (v) => updateJoinCode(v), isActive, "e.g. A1B2C3");
          addInfoLine(authBody, "The banner above always shows the code currently in use.");

          const captureDetailBody = addFormSection(form, "Capture Detail", "Adjust stream quality for any capture types that are turned on above.");
          let hasDetailControl = false;
          if (cfg.streams.imu.enabled) {
            hasDetailControl = true;
            addSelect(captureDetailBody, "Motion detail", String(cfg.streams.imu.rate_hz || 30), [
              { value: "10", label: "Light (10 Hz)" },
              { value: "30", label: "Balanced (30 Hz)" },
              { value: "60", label: "High (60 Hz)" }
            ], (v) => updateSessionCfg((c) => c.streams.imu.rate_hz = Number(v)), isActive);
          }

          if (cfg.streams.camera.mode !== "off") {
            hasDetailControl = true;
            addSelect(captureDetailBody, "Camera preview speed", String(cfg.streams.camera.fps || 10), [
              { value: "5", label: "Low (5 FPS)" },
              { value: "10", label: "Balanced (10 FPS)" },
              { value: "15", label: "Smooth (15 FPS)" },
              { value: "30", label: "High (30 FPS)" }
            ], (v) => updateSessionCfg((c) => c.streams.camera.fps = Number(v)), isActive);
          }

          if (cfg.streams.audio.enabled) {
            hasDetailControl = true;
            addSelect(captureDetailBody, "Audio update rate", String(cfg.streams.audio.rate_hz || 10), [
              { value: "5", label: "Light (5 Hz)" },
              { value: "10", label: "Balanced (10 Hz)" },
              { value: "20", label: "High (20 Hz)" }
            ], (v) => updateSessionCfg((c) => c.streams.audio.rate_hz = Number(v)), isActive);
          }

          if (cfg.streams.gps.enabled) {
            hasDetailControl = true;
            addSelect(captureDetailBody, "Location update rate", String(cfg.streams.gps.rate_hz || 1), [
              { value: "1", label: "Battery saver (1 Hz)" },
              { value: "2", label: "Balanced (2 Hz)" },
              { value: "5", label: "High (5 Hz)" }
            ], (v) => updateSessionCfg((c) => c.streams.gps.rate_hz = Number(v)), isActive);
          }
          if (!hasDetailControl) {
            addInfoLine(captureDetailBody, "Turn on a capture type above to reveal its detail controls here.");
          }
        };

        function updateSessionCfg(mutator) {
          const st = store.getState();
          const isActive = (st.sessionState || "draft") === "active" || !!st.recording?.active;
          if (isActive) return;
          const next = mergeRunConfig(st.sessionConfig || defaultRunConfig);
          mutator(next);
          store.setState({ sessionConfig: next, sessionState: "draft" });
          sendJson({ type: "session_config_update", sessionConfig: next });
        }

        function updateJoinCode(value) {
          const st = store.getState();
          const isActive = (st.sessionState || "draft") === "active" || !!st.recording?.active;
          if (isActive) return;
          const next = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
          store.setState({ sessionJoinCode: next });
          sendJson({ type: "session_auth_update", joinCode: next });
        }

        const unsub = store.subscribe((s) => ({ cfg: s.sessionConfig, rec: s.recording, list: s.deviceList, state: s.sessionState, joinCode: s.sessionJoinCode }), onStateChange);
        onStateChange();

        return () => {
          unsub();
          for (const timer of pendingCaptureTimers.values()) clearTimeout(timer);
        };
      }
    },    imu_plot: {
      title: "IMU Time Series",
      defaults: { w: 8, h: 4, pinned: false, settings: { device_id: "global", time_window_sec: 15 } },
      settingsSchema: [deviceSettingSchema()],
      render(content, ctx) {
        const motionBadge = document.createElement("div");
        motionBadge.className = "pill motion-pill";
        motionBadge.textContent = "Motion: IDLE";
        content.appendChild(motionBadge);

        const controls = document.createElement("div");
        controls.className = "row imu-controls";

        const windowLabel = document.createElement("label");
        windowLabel.textContent = "Window";
        const windowSelect = document.createElement("select");
        ["5", "15", "60"].forEach((s) => {
          const o = document.createElement("option");
          o.value = s;
          o.textContent = `${s}s`;
          windowSelect.appendChild(o);
        });

        let windowSec = Number(ctx.instance.settings.time_window_sec || 15);
        if (![5, 15, 60].includes(windowSec)) windowSec = 15;
        windowSelect.value = String(windowSec);
        windowLabel.appendChild(windowSelect);

        const pauseBtn = mkBtn("Pause", () => {
          paused = !paused;
          pauseBtn.textContent = paused ? "Resume" : "Pause";
          drawAll();
        }, "btn-alt");

        const autoScaleWrap = document.createElement("label");
        autoScaleWrap.className = "toggle-line";
        const autoScaleCb = document.createElement("input");
        autoScaleCb.type = "checkbox";
        autoScaleCb.checked = true;
        autoScaleWrap.append(autoScaleCb, document.createTextNode(" Auto-scale"));

        const axisWrap = document.createElement("div");
        axisWrap.className = "row";
        const axisState = { x: true, y: true, z: true };
        ["x", "y", "z"].forEach((axis) => {
          const lab = document.createElement("label");
          lab.className = "toggle-line";
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.checked = true;
          cb.addEventListener("change", () => {
            axisState[axis] = cb.checked;
            drawAll();
          });
          lab.append(cb, document.createTextNode(` ${axis.toUpperCase()}`));
          axisWrap.appendChild(lab);
        });

        controls.append(windowLabel, pauseBtn, autoScaleWrap, axisWrap);
        content.appendChild(controls);

        const accelTitle = document.createElement("p");
        accelTitle.className = "mono muted";
        accelTitle.textContent = "Accelerometer (m/s?)";
        content.appendChild(accelTitle);
        content.appendChild(makeAxisLegend());

        const accelCanvas = document.createElement("canvas");
        accelCanvas.width = 900;
        accelCanvas.height = 140;
        content.appendChild(accelCanvas);

        const gyroTitle = document.createElement("p");
        gyroTitle.className = "mono muted";
        gyroTitle.textContent = "Gyroscope (rad/s)";
        content.appendChild(gyroTitle);
        content.appendChild(makeAxisLegend());

        const gyroCanvas = document.createElement("canvas");
        gyroCanvas.width = 900;
        gyroCanvas.height = 140;
        content.appendChild(gyroCanvas);

        const foot = document.createElement("div");
        foot.className = "mono muted";
        content.appendChild(foot);

        let paused = false;
        let lastTs = null;
        const samples = [];

        windowSelect.addEventListener("change", () => {
          windowSec = Number(windowSelect.value || 15);
          drawAll();
        });
        autoScaleCb.addEventListener("change", drawAll);

        const unsub = store.subscribe((s) => ({ states: s.statesByDevice, list: s.deviceList }), () => {
          const st = store.getState();
          const deviceId = getWidgetDevice(ctx.instance.settings);
          const imu = st.statesByDevice[deviceId]?.imu_latest;
          if (!paused && imu?.t_recv_ms && Array.isArray(imu.accel_mps2) && Array.isArray(imu.gyro_rads)) {
            if (lastTs !== imu.t_recv_ms) {
              lastTs = imu.t_recv_ms;
              samples.push({
                ts: Number(imu.t_recv_ms),
                accel: [Number(imu.accel_mps2[0] || 0), Number(imu.accel_mps2[1] || 0), Number(imu.accel_mps2[2] || 0)],
                gyro: [Number(imu.gyro_rads[0] || 0), Number(imu.gyro_rads[1] || 0), Number(imu.gyro_rads[2] || 0)]
              });
            }
          }
          const latestMotion = st.statesByDevice[deviceId]?.motion_state || "";
          motionBadge.textContent = `Motion: ${latestMotion === "HIGH" || latestMotion === "MOVING" ? "ACTIVE" : "IDLE"}`;
          motionBadge.classList.toggle("motion-active", latestMotion === "HIGH" || latestMotion === "MOVING");
          trimSamples(samples, windowSec);
          drawAll();

          const latest = samples[samples.length - 1];
          foot.textContent = latest
            ? `device=${deviceId || "-"} samples=${samples.length} t=${formatTs(latest.ts)}`
            : `device=${deviceId || "-"} samples=0`;
        });

        function drawAll() {
          drawTriAxisTimeSeries(accelCanvas, samples, "accel", {
            showAxes: axisState,
            autoScale: autoScaleCb.checked,
            fixedRange: 20,
            windowSec
          });
          drawTriAxisTimeSeries(gyroCanvas, samples, "gyro", {
            showAxes: axisState,
            autoScale: autoScaleCb.checked,
            fixedRange: 8,
            windowSec
          });
        }

        return () => unsub();
      }
    },

    camera_preview: {
      title: "Camera Views",
      defaults: { w: 12, h: 4, pinned: false, settings: { device_id: "global" } },
      settingsSchema: [deviceSettingSchema()],
      render(content, ctx) {
        content.closest(".widget-card")?.classList.add("widget-cam-full");
        content.classList.add("cam-content", "monitor-widget-content");

        const tabs = document.createElement("div");
        tabs.className = "monitor-tabs";
        tabs.setAttribute("role", "tablist");
        const stage = document.createElement("div");
        stage.className = "monitor-stage is-cameras";

        const mapPanel = document.createElement("section");
        mapPanel.className = "monitor-map-panel gps-live-content";

        const cameraPanel = document.createElement("section");
        cameraPanel.className = "monitor-camera-panel";

        stage.append(mapPanel, cameraPanel);
        content.append(tabs, stage);

        let activeMode = "cameras";
        const tabButtons = new Map();
        const mapView = mountGpsLivePanel(mapPanel, {
          store,
          getDeviceId: () => getWidgetDevice(ctx.instance.settings)
        });

        const setMode = (nextMode) => {
          activeMode = ["cameras", "map", "combined"].includes(nextMode) ? nextMode : "cameras";
          stage.className = `monitor-stage is-${activeMode}`;
          for (const [mode, button] of tabButtons.entries()) {
            const selected = mode === activeMode;
            button.classList.toggle("is-active", selected);
            button.setAttribute("aria-selected", selected ? "true" : "false");
          }
          requestAnimationFrame(() => mapView.refresh());
        };

        for (const [mode, label] of [["cameras", "Cameras"], ["map", "Map"], ["combined", "All Live"]]) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "monitor-tab";
          button.textContent = label;
          button.setAttribute("role", "tab");
          button.addEventListener("click", () => setMode(mode));
          tabButtons.set(mode, button);
          tabs.appendChild(button);
        }

        const grid = document.createElement("div");
        grid.className = "camview-grid";
        const cards = new Map();
        const empty = document.createElement("div");
        empty.className = "camview-empty";
        empty.textContent = "No devices connected";
        cameraPanel.appendChild(grid);
        grid.appendChild(empty);

        function destroyCard(deviceId) {
          const card = cards.get(deviceId);
          if (!card) return;
          try { card.detachPreview?.(); } catch {}
          card.root.remove();
          cards.delete(deviceId);
        }

        function ensureCard(deviceId) {
          let card = cards.get(deviceId);
          if (card) return card;

          const root = document.createElement("div");
          root.className = "camview-card";

          const header = document.createElement("div");
          header.className = "camview-header";
          const title = document.createElement("span");
          title.className = "camview-title";
          const fps = document.createElement("span");
          fps.className = "camview-fps";
          const badge = document.createElement("span");
          badge.className = "camview-badge offline";
          badge.textContent = "OFFLINE";
          header.append(title, fps, badge);

          const frame = document.createElement("div");
          frame.className = "camview-frame";
          const video = document.createElement("video");
          video.className = "camview-video";
          video.muted = true;
          video.autoplay = true;
          video.playsInline = true;
          const img = document.createElement("img");
          img.className = "camview-img";
          img.alt = deviceId;
          img.addEventListener("dblclick", () => {
            const ts = Number(card.lastCamTs || Date.now());
            window.open(`/latest.jpg?device_id=${encodeURIComponent(deviceId)}&ts=${ts}`, "_blank", "noopener");
          });
          const placeholder = document.createElement("div");
          placeholder.className = "camview-placeholder";
          placeholder.innerHTML = `<div class="camera-icon" aria-hidden="true"></div><p>No feed</p>`;
          const placeholderText = placeholder.querySelector("p");
          frame.append(video, img, placeholder);

          root.append(header, frame);
          grid.appendChild(root);

          card = {
            root,
            title,
            fps,
            badge,
            video,
            img,
            placeholder,
            placeholderText,
            lastCamTs: 0,
            detachPreview: previewRtc?.registerSink(deviceId, video) || null
          };
          cards.set(deviceId, card);
          return card;
        }

        function renderCards() {
          const st = store.getState();
          const selectedDeviceId = getWidgetDevice(ctx.instance.settings);
          const visibleDevices = selectedDeviceId
            ? (st.deviceList || []).filter((summary) => String(summary?.device_id || "") === selectedDeviceId)
            : (st.deviceList || []);
          const activeIds = new Set();
          const now = Date.now();

          for (const summary of visibleDevices) {
            const deviceId = summary.device_id;
            activeIds.add(deviceId);
            const card = ensureCard(deviceId);
            const state = st.statesByDevice?.[deviceId] || {};
            const camTs = Number(state?.camera_latest_ts || 0);
            const fresh = camTs > 0 && (now - camTs) < 4000;
            const fpsVal = Number(summary?.camFps ?? summary?.camera_fps ?? state?.net?.camera_fps ?? 0);
            const rec = st.recordByDevice?.[deviceId];
            const isCamRecording = !!rec?.recording && !!rec?.modalities?.cam;
            const isOnline = summary.connected !== false;
            const previewEnabled = !!state?.stream_status?.camera?.enabled;
            previewRtc?.updateAvailability(deviceId, { connected: isOnline, previewEnabled });
            const previewState = previewRtc?.getState(deviceId) || { live: false, connecting: false, error: "", stream: null };
            const showVideo = !!previewState.live;
            const showImage = !showVideo && fresh;
            let statusClass = "offline";
            let statusLabel = "OFFLINE";
            let placeholderText = previewEnabled ? "No feed" : "Camera disabled";
            if (!isOnline) {
              placeholderText = "Device offline";
            } else if (showVideo) {
              statusClass = isCamRecording ? "rec" : "live";
              statusLabel = isCamRecording ? "REC" : "LIVE";
            } else if (showImage) {
              statusClass = isCamRecording ? "rec" : "live";
              statusLabel = isCamRecording ? "REC" : "LIVE";
            } else if (previewState.connecting && previewEnabled) {
              statusClass = isCamRecording ? "rec" : "live";
              statusLabel = "LINK";
              placeholderText = "Connecting live preview";
            } else if (previewState.error) {
              placeholderText = previewState.error;
              statusLabel = "WAIT";
            } else if (previewEnabled) {
              statusLabel = "WAIT";
              placeholderText = "Waiting for camera";
            }
            const displayName = String(summary.deviceName || deviceId);

            card.title.textContent = displayName;
            card.badge.className = `camview-badge ${statusClass}`;
            card.badge.textContent = statusLabel;
            card.fps.textContent = showVideo ? "RTC" : (fresh && fpsVal > 0 ? `${fpsVal.toFixed(1)} fps` : "");
            if (card.placeholderText) card.placeholderText.textContent = placeholderText;

            if (showImage) {
              if (card.lastCamTs !== camTs) {
                card.img.src = `/latest.jpg?device_id=${encodeURIComponent(deviceId)}&ts=${camTs}`;
                card.lastCamTs = camTs;
              }
            }
            card.video.style.display = showVideo ? "" : "none";
            card.img.style.display = showImage ? "" : "none";
            card.placeholder.style.display = showVideo || showImage ? "none" : "flex";
          }

          for (const deviceId of [...cards.keys()]) {
            if (activeIds.has(deviceId)) continue;
            previewRtc?.updateAvailability(deviceId, { connected: false, previewEnabled: false });
            destroyCard(deviceId);
          }

          empty.style.display = activeIds.size ? "none" : "";
        }

        const unsubStore = store.subscribe((s) => ({ deviceList: s.deviceList, statesByDevice: s.statesByDevice, recordByDevice: s.recordByDevice }), renderCards);
        const unsubPreview = bus.on("preview_rtc_update", ({ deviceId } = {}) => {
          if (!deviceId || cards.has(deviceId)) renderCards();
        });
        setMode("cameras");
        renderCards();

        return () => {
          unsubStore();
          unsubPreview();
          mapView.destroy();
          for (const deviceId of [...cards.keys()]) destroyCard(deviceId);
        };
      }
    },


    gps_live: {
      title: "Live Map",
      defaults: { w: 8, h: 4, pinned: false, settings: { device_id: "global" } },
      settingsSchema: [deviceSettingSchema()],
      render(content, ctx) {
        content.classList.add("gps-live-content");
        const mapView = mountGpsLivePanel(content, {
          store,
          getDeviceId: () => getWidgetDevice(ctx.instance.settings)
        });
        return () => {
          mapView.destroy();
        };
      }
    },    events_timeline: {
      title: "Events",
      defaults: { w: 6, h: 2, pinned: false, settings: { device_id: "global" } },
      settingsSchema: [deviceSettingSchema()],
      render(content, ctx) {
        const row = document.createElement("div");
        row.className = "row";
        const input = document.createElement("input");
        input.type = "text";
        input.placeholder = "event label";
        const mark = mkBtn("? Tag Event", () => {
          const deviceId = getWidgetDevice(ctx.instance.settings);
          sendJson({ type: "event", device_id: deviceId, label: (input.value || "event").trim() });
          input.value = "";
        });
        row.append(input, mark);
        content.appendChild(row);

        const ul = document.createElement("ul");
        ul.className = "timeline";
        content.appendChild(ul);
        const unsub = store.subscribe((s) => s.statesByDevice, () => {
          const st = store.getState();
          const deviceId = getWidgetDevice(ctx.instance.settings);
          const events = st.statesByDevice[deviceId]?.event_timeline || [];
          ul.innerHTML = "";
          for (let i = events.length - 1; i >= 0; i -= 1) {
            const ev = events[i];
            const li = document.createElement("li");
            li.textContent = `${formatTs(ev.t_recv_ms)} ${ev.source || "unknown"}: ${ev.label || ""}`;
            ul.appendChild(li);
          }
        });
        return () => unsub();
      }
    },

    replay: {
      title: "Dataset Replay",
      defaults: { w: 12, h: 3, pinned: false, settings: { device_id: "global", speed: "1" } },
      settingsSchema: [deviceSettingSchema(), { key: "speed", type: "select", label: "Speed", options: ["0.5", "1", "2"] }],
      render(content, ctx) {
        const row = document.createElement("div");
        row.className = "row";
        const reload = mkBtn("Reload", () => loadReplaySessions());
        const sel = document.createElement("select");
        const play = mkBtn("? Play", onPlay, "btn-success");
        const stop = mkBtn("? Stop", onStop, "btn-danger");
        row.append(reload, sel, play, stop);
        content.appendChild(row);

        const status = document.createElement("p");
        status.className = "mono muted";
        status.textContent = "Replay: idle";
        content.appendChild(status);
        const summary = document.createElement("div");
        summary.className = "kv-grid replay-summary";
        content.appendChild(summary);

        let timer = null;
        function refresh() {
          const sessions = store.getState().replaySessions || [];
          sel.innerHTML = "";
          for (const id of sessions) {
            const o = document.createElement("option");
            o.value = id;
            o.textContent = id;
            sel.appendChild(o);
          }
          if (!sessions.length) {
            const o = document.createElement("option");
            o.value = "";
            o.textContent = "No datasets";
            sel.appendChild(o);
          }
        }

        async function onPlay() {
          const id = sel.value;
          if (!id) return;
          onStop();
          const deviceId = getWidgetDevice(ctx.instance.settings);
          const qs = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
          const manifest = await (await fetch(`/api/datasets/${encodeURIComponent(id)}/manifest${qs}`)).json();
          const speed = Math.max(0.25, Number(ctx.instance.settings.speed || 1));
          const camRows = manifest.cameraTimestampsCsv ? parseCameraTsCsv(await (await fetch(manifest.cameraTimestampsCsv)).text()) : [];
          const imuRows = manifest.imuCsv ? parseImuCsv(await (await fetch(manifest.imuCsv)).text()) : [];
          const evRows = manifest.eventsCsv ? parseEventsCsv(await (await fetch(manifest.eventsCsv)).text()) : [];
          if (!camRows.length && !imuRows.length && !evRows.length) {
            status.textContent = "Replay: no data";
            return;
          }
          const startTs = (imuRows[0]?.t_recv_ms) || (evRows[0]?.t_recv_ms) || (camRows[0]?.t_recv_ms) || Date.now();
          const endTs = Math.max(
            imuRows.length ? imuRows[imuRows.length - 1].t_recv_ms : startTs,
            evRows.length ? evRows[evRows.length - 1].t_recv_ms : startTs,
            camRows.length ? camRows[camRows.length - 1].t_recv_ms : startTs
          );
          const wallStart = Date.now();
          let camIdx = 0;
          timer = setInterval(() => {
            const nowTs = startTs + (Date.now() - wallStart) * speed;
            while (camIdx < camRows.length && camRows[camIdx].t_recv_ms <= nowTs) {
              if (manifest.device_id) bus.emit("preview_image", `/datasets/${id}/devices/${manifest.device_id}/streams/camera/${camRows[camIdx].filename}`);
              camIdx += 1;
            }
            status.textContent = `Replay: ${id} @ ${speed}x`;
            if (nowTs >= endTs) onStop("Replay: done");
          }, 50);
        }

        function onStop(text = "Replay: idle") {
          if (timer) clearInterval(timer);
          timer = null;
          status.textContent = text;
        }

        const unsub = store.subscribe((s) => s.replaySessions, refresh);
        sel.addEventListener("change", async () => {
          const id = sel.value;
          if (!id) {
            summary.innerHTML = "";
            return;
          }
          const deviceId = getWidgetDevice(ctx.instance.settings);
          const qs = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
          try {
            const manifest = await (await fetch(`/api/datasets/${encodeURIComponent(id)}/manifest${qs}`)).json();
            summary.innerHTML = "";
            kv(summary, "Dataset", id);
            kv(summary, "Device", manifest.device_id || "-");
            kv(summary, "IMU", manifest.imuCsv ? "yes" : "no");
            kv(summary, "GPS", manifest.gpsCsv ? "yes" : "no");
            kv(summary, "Audio", manifest.audioWav ? "wav" : (manifest.audioCsv ? "csv" : "no"));
            kv(summary, "Camera", manifest.cameraVideo ? "mp4" : (manifest.cameraDir ? "frames" : "no"));
          } catch {
            summary.innerHTML = "";
          }
        });
        refresh();
        sel.dispatchEvent(new Event("change"));
        return () => { onStop(); unsub(); };
      }
    },

    json_state: {
      title: "Debug JSON",
      defaults: { w: 12, h: 2, pinned: false, settings: { device_id: "global" } },
      settingsSchema: [deviceSettingSchema()],
      render(content, ctx) {
        const pre = document.createElement("pre");
        pre.className = "json-view";
        content.appendChild(pre);
        const unsub = store.subscribe((s) => ({ ws: s.wsConnected, list: s.deviceList, rec: s.recording, states: s.statesByDevice }), () => {
          const st = store.getState();
          const deviceId = getWidgetDevice(ctx.instance.settings);
          pre.textContent = JSON.stringify({
            ws: st.wsConnected,
            device_id: deviceId,
            recording: st.recording,
            summary: st.deviceList,
            focused: st.statesByDevice[deviceId] || null
          }, null, 2);
        });
        return () => unsub();
      }
    }
  };
}
function render(box, ctx) {
  const st = ctx.store.getState();
  const deviceId = getWidgetDevice(ctx.instance.settings);
  const d = st.statesByDevice[deviceId] || {};
  const rtt = d.net?.rtt_ms == null ? "-" : `${Number(d.net.rtt_ms).toFixed(0)} ms`;
  box.innerHTML = "";
  kv(box, "WS", st.wsConnected ? "connected" : "disconnected");
  kv(box, "Device", deviceId || "-");
  kv(box, "Recording", st.recording.active ? `${st.recording.mode} (${formatElapsed(st.recording.elapsed_sec)})` : "off");
  kv(box, "IMU Hz", Number(d.net?.imu_hz || 0).toFixed(1));
  kv(box, "Camera FPS", Number(d.net?.camera_fps || 0).toFixed(1));
  kv(box, "Dropped", String(d.net?.dropped_packets || 0));
  kv(box, "RTT", rtt);
}

function drawImu(canvas, points) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const style = getComputedStyle(document.documentElement);
  const lineColor = style.getPropertyValue("--plot-line").trim() || "#6c74c9";
  const gridColor = style.getPropertyValue("--plot-grid").trim() || "#cccccc";
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = gridColor;
  ctx.beginPath();
  ctx.moveTo(0, h - 1);
  ctx.lineTo(w, h - 1);
  ctx.stroke();
  if (points.length < 2) return;
  let max = 12;
  for (const p of points) max = Math.max(max, p.mag);
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < points.length; i += 1) {
    const x = (i / (points.length - 1)) * w;
    const y = h - (points[i].mag / max) * (h - 8) - 4;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function makeAxisLegend() {
  const wrap = document.createElement("div");
  wrap.className = "axis-legend";
  const entries = [
    { label: "X", color: "#4caf50" },
    { label: "Y", color: "#2196f3" },
    { label: "Z", color: "#ff9800" }
  ];
  for (const e of entries) {
    const item = document.createElement("span");
    item.className = "axis-legend-item";
    const dot = document.createElement("span");
    dot.className = "axis-legend-dot";
    dot.style.background = e.color;
    item.append(dot, document.createTextNode(e.label));
    wrap.appendChild(item);
  }
  return wrap;
}

function trimSamples(samples, windowSec) {
  if (!samples.length) return;
  const maxAgeMs = Number(windowSec || 15) * 1000;
  const newestTs = samples[samples.length - 1].ts;
  while (samples.length && newestTs - samples[0].ts > maxAgeMs) samples.shift();
}

function drawTriAxisTimeSeries(canvas, samples, key, opts) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const style = getComputedStyle(document.documentElement);
  const gridColor = style.getPropertyValue("--plot-grid").trim() || "#cccccc";
  const colors = { x: "#4caf50", y: "#2196f3", z: "#ff9800" };

  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  if (!samples.length) return;

  const axes = ["x", "y", "z"].filter((a) => opts.showAxes[a]);
  if (!axes.length) return;

  const newestTs = samples[samples.length - 1].ts;
  const oldestTs = newestTs - Number(opts.windowSec || 15) * 1000;
  const xSpan = Math.max(1, newestTs - oldestTs);

  let maxAbs = Number(opts.fixedRange || 10);
  if (opts.autoScale) {
    maxAbs = 0.2;
    for (const s of samples) {
      const arr = key === "accel" ? s.accel : s.gyro;
      if (!arr) continue;
      if (opts.showAxes.x) maxAbs = Math.max(maxAbs, Math.abs(arr[0]));
      if (opts.showAxes.y) maxAbs = Math.max(maxAbs, Math.abs(arr[1]));
      if (opts.showAxes.z) maxAbs = Math.max(maxAbs, Math.abs(arr[2]));
    }
    maxAbs *= 1.15;
  }

  const toX = (ts) => ((ts - oldestTs) / xSpan) * w;
  const toY = (v) => h / 2 - (v / maxAbs) * ((h / 2) - 6);

  const axisIdx = { x: 0, y: 1, z: 2 };
  for (const axis of axes) {
    const idx = axisIdx[axis];
    ctx.strokeStyle = colors[axis];
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    let moved = false;
    for (const s of samples) {
      if (s.ts < oldestTs) continue;
      const arr = key === "accel" ? s.accel : s.gyro;
      if (!arr) continue;
      const x = toX(s.ts);
      const y = toY(arr[idx]);
      if (!moved) { ctx.moveTo(x, y); moved = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

function ingestGpsLiveState(state) {
  const list = Array.isArray(state?.deviceList) ? state.deviceList : [];
  const nameById = new Map(list.map((device) => [String(device.device_id || ""), String(device.deviceName || device.device_id || "")]));
  const ids = new Set([
    ...Object.keys(state?.statesByDevice || {}),
    ...list.map((device) => String(device.device_id || ""))
  ]);
  for (const deviceId of ids) {
    if (!deviceId) continue;
    const latest = state?.statesByDevice?.[deviceId]?.gps_latest || null;
    if (!latest) continue;
    ingestGpsLivePoint(deviceId, latest, nameById.get(deviceId) || deviceId);
  }
}

function ingestGpsLivePoint(deviceId, latest, deviceName = "") {
  const lat = Number(latest?.lat);
  const lon = Number(latest?.lon);
  const ts = Number(latest?.t_recv_ms || 0);
  if (!isValidGpsCoordinate(lat, lon) || !ts) return;
  const entry = getOrCreateGpsTrail(deviceId, deviceName);
  entry.name = deviceName || entry.name || deviceId;
  if (entry.lastTs === ts) return;
  entry.lastTs = ts;
  entry.points.push({
    ts,
    lat,
    lon,
    accuracy_m: Number.isFinite(Number(latest?.accuracy_m)) ? Number(latest.accuracy_m) : -1,
    speed_mps: Number.isFinite(Number(latest?.speed_mps)) ? Number(latest.speed_mps) : -1,
    heading_deg: Number.isFinite(Number(latest?.heading_deg)) ? Number(latest.heading_deg) : -1
  });
  trimGpsTrailPoints(entry.points, ts);
}

function getOrCreateGpsTrail(deviceId, deviceName = "") {
  const key = String(deviceId || "").trim();
  let entry = gpsLiveTrailCache.get(key);
  if (entry) return entry;
  entry = {
    deviceId: key,
    name: deviceName || key,
    lastTs: 0,
    points: []
  };
  gpsLiveTrailCache.set(key, entry);
  return entry;
}

function trimGpsTrailPoints(points, newestTs) {
  const maxAgeMs = GPS_LIVE_TRAIL_MAX_AGE_MS;
  while (points.length > GPS_LIVE_TRAIL_MAX_POINTS) points.shift();
  while (points.length && newestTs - Number(points[0]?.ts || 0) > maxAgeMs) points.shift();
}

function buildGpsLiveTracks(state, selectedDeviceId = "") {
  const list = Array.isArray(state?.deviceList) ? state.deviceList : [];
  const summaryById = new Map(list.map((device) => [String(device.device_id || ""), device]));
  const ids = selectedDeviceId
    ? [String(selectedDeviceId)]
    : [...new Set([...summaryById.keys(), ...gpsLiveTrailCache.keys()])];
  const now = Date.now();
  const tracks = [];

  for (const deviceId of ids) {
    const entry = gpsLiveTrailCache.get(deviceId);
    const summary = summaryById.get(deviceId) || {};
    const latest = state?.statesByDevice?.[deviceId]?.gps_latest || null;
    if (latest) ingestGpsLivePoint(deviceId, latest, String(summary.deviceName || deviceId));
    const freshEntry = gpsLiveTrailCache.get(deviceId);
    const sampledPoints = sampleGpsTrailPoints(freshEntry?.points || []);
    if (!sampledPoints.length) continue;
    const latestPoint = sampledPoints[sampledPoints.length - 1];
    const ageMs = latestPoint?.ts ? Math.max(0, now - Number(latestPoint.ts)) : Number.POSITIVE_INFINITY;
    tracks.push({
      deviceId,
      name: String(summary.deviceName || freshEntry?.name || deviceId),
      color: gpsLiveColorForDevice(deviceId),
      connected: summary.connected !== false,
      ageMs,
      live: ageMs <= 6000,
      stale: ageMs > 6000 && ageMs <= GPS_LIVE_STALE_MS,
      points: sampledPoints,
      latest: latestPoint
    });
  }

  return tracks.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
}

function sampleGpsTrailPoints(points) {
  if (!Array.isArray(points) || !points.length) return [];
  if (points.length <= GPS_LIVE_DRAW_MAX_POINTS) return points.slice();
  const step = Math.ceil(points.length / GPS_LIVE_DRAW_MAX_POINTS);
  const sampled = [];
  for (let i = 0; i < points.length; i += step) sampled.push(points[i]);
  if (sampled[sampled.length - 1] !== points[points.length - 1]) sampled.push(points[points.length - 1]);
  return sampled;
}

function gpsLiveColorForDevice(deviceId) {
  const key = String(deviceId || "");
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = ((hash * 31) + key.charCodeAt(i)) >>> 0;
  return GPS_LIVE_COLORS[hash % GPS_LIVE_COLORS.length];
}

function computeGpsLiveView(tracks, width, height) {
  const allPoints = tracks.flatMap((track) => track.points).filter((point) => isValidGpsCoordinate(point.lat, point.lon));
  if (!allPoints.length || width < 40 || height < 40) return null;

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const point of allPoints) {
    const world = latLonToWorld(point.lat, point.lon);
    minX = Math.min(minX, world.x);
    maxX = Math.max(maxX, world.x);
    minY = Math.min(minY, world.y);
    maxY = Math.max(maxY, world.y);
  }

  const pointCount = allPoints.length;
  const paddingPx = Math.max(32, Math.min(width, height) * 0.12);
  const usableWidth = Math.max(1, width - paddingPx * 2);
  const usableHeight = Math.max(1, height - paddingPx * 2);
  const spanX = Math.max(maxX - minX, pointCount === 1 ? 0 : 1e-6);
  const spanY = Math.max(maxY - minY, pointCount === 1 ? 0 : 1e-6);

  let zoom = 16;
  if (pointCount > 1) {
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
  const centerLat = allPoints[Math.floor(allPoints.length / 2)]?.lat ?? tracks[0]?.latest?.lat ?? 0;
  const metersPerPx = 156543.03392 * Math.cos((centerLat * Math.PI) / 180) / (2 ** zoom);

  return {
    width,
    height,
    zoom,
    scale,
    centerWorldX,
    centerWorldY,
    centerPxX,
    centerPxY,
    metersPerPx,
    project(lat, lon) {
      const world = latLonToWorld(lat, lon);
      return {
        x: (world.x * scale) - centerPxX + (width / 2),
        y: (world.y * scale) - centerPxY + (height / 2)
      };
    }
  };
}

function latLonToWorld(lat, lon) {
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, Number(lat || 0)));
  const normalizedLon = Math.max(-180, Math.min(180, Number(lon || 0)));
  const x = (normalizedLon + 180) / 360;
  const sin = Math.sin((clampedLat * Math.PI) / 180);
  const y = 0.5 - (Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI));
  return { x, y };
}

function drawGpsLiveBackdrop(ctx, width, height) {
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#0d1527");
  gradient.addColorStop(1, "#12203b");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
  ctx.lineWidth = 1;
  const step = 48;
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

function drawGpsLiveTiles(ctx, view, onInvalidate) {
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
      const tile = ensureGpsLiveTile(view.zoom, wrappedTileX, rawTileY, onInvalidate);
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

function ensureGpsLiveTile(z, x, y, onInvalidate) {
  const key = `${z}/${x}/${y}`;
  let entry = gpsLiveTileCache.get(key);
  if (entry) return entry;
  const image = new Image();
  entry = { status: "loading", image };
  gpsLiveTileCache.set(key, entry);
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

function drawGpsLiveTrack(ctx, track, view) {
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
  ctx.arc(last.x, last.y, track.live ? 6 : 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  const label = `${track.name}${track.live ? "" : ` · ${Math.round(track.ageMs / 1000)}s`}`;
  ctx.font = '600 12px "IBM Plex Mono", ui-monospace, monospace';
  const metrics = ctx.measureText(label);
  const labelX = Math.max(8, Math.min(view.width - metrics.width - 18, last.x + 10));
  const labelY = Math.max(18, Math.min(view.height - 10, last.y - 10));

  ctx.fillStyle = "rgba(8, 12, 20, 0.78)";
  ctx.fillRect(labelX - 6, labelY - 13, metrics.width + 12, 20);
  ctx.strokeStyle = `${track.color}88`;
  ctx.lineWidth = 1;
  ctx.strokeRect(labelX - 6, labelY - 13, metrics.width + 12, 20);
  ctx.fillStyle = "#f8fafc";
  ctx.fillText(label, labelX, labelY + 1);
  ctx.restore();
}

function drawGpsLiveCrosshair(ctx, width, height) {
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

function renderGpsLiveLegend(container, tracks) {
  container.innerHTML = "";
  for (const track of tracks) {
    const item = document.createElement("div");
    item.className = `gps-live-chip ${track.live ? "is-live" : track.stale ? "is-stale" : "is-old"}`;
    const swatch = document.createElement("span");
    swatch.className = "gps-live-chip-swatch";
    swatch.style.background = track.color;
    const text = document.createElement("span");
    text.textContent = `${track.name} · ${track.latest?.lat?.toFixed?.(5) || "-"}, ${track.latest?.lon?.toFixed?.(5) || "-"}`;
    item.append(swatch, text);
    container.appendChild(item);
  }
}

function formatGpsLiveMetersPerPx(metersPerPx) {
  const value = Math.max(0, Number(metersPerPx || 0));
  if (!value) return "scale --";
  if (value >= 1000) return `${(value / 1000).toFixed(2)} km/px`;
  if (value >= 100) return `${Math.round(value)} m/px`;
  return `${value.toFixed(1)} m/px`;
}

function isValidGpsCoordinate(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function mountGpsLivePanel(container, { store, getDeviceId = () => "" } = {}) {
  container.innerHTML = "";

  const shell = document.createElement("div");
  shell.className = "gps-live-shell";

  const meta = document.createElement("div");
  meta.className = "gps-live-meta mono";

  const legend = document.createElement("div");
  legend.className = "gps-live-legend";

  const viewport = document.createElement("div");
  viewport.className = "gps-live-viewport";

  const canvas = document.createElement("canvas");
  canvas.className = "gps-live-canvas";
  viewport.appendChild(canvas);

  const overlay = document.createElement("div");
  overlay.className = "gps-live-overlay";
  const status = document.createElement("div");
  status.className = "gps-live-status";
  const attribution = document.createElement("div");
  attribution.className = "gps-live-attribution";
  attribution.innerHTML = '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer noopener">© OpenStreetMap</a> · <a href="https://carto.com/attributions" target="_blank" rel="noreferrer noopener">© CARTO</a>';
  overlay.append(status, attribution);
  viewport.appendChild(overlay);

  shell.append(meta, viewport, legend);
  container.appendChild(shell);

  let disposed = false;
  let framePending = false;
  let resizeObserver = null;
  let windowResizeHandler = null;

  const scheduleRender = () => {
    if (disposed || framePending) return;
    framePending = true;
    requestAnimationFrame(() => {
      framePending = false;
      renderMap();
    });
  };

  const syncCanvasSize = () => {
    const rect = viewport.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const nextWidth = Math.max(1, Math.round(width * dpr));
    const nextHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
      canvas.width = nextWidth;
      canvas.height = nextHeight;
    }
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    return { width, height, dpr };
  };

  const renderMap = () => {
    if (disposed) return;
    const size = syncCanvasSize();
    if (!size.width || !size.height) return;
    const st = store.getState();
    ingestGpsLiveState(st);
    const tracks = buildGpsLiveTracks(st, String(getDeviceId?.() || ""));
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;
    ctx2d.setTransform(1, 0, 0, 1, 0, 0);
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    ctx2d.scale(size.dpr, size.dpr);

    const view = computeGpsLiveView(tracks, size.width, size.height);
    drawGpsLiveBackdrop(ctx2d, size.width, size.height);

    if (!tracks.length || !view) {
      const selectedDeviceId = String(getDeviceId?.() || "");
      status.hidden = false;
      status.textContent = selectedDeviceId
        ? "Waiting for live GPS fixes from this phone."
        : "Waiting for phones to report location.";
      meta.textContent = tracks.length ? "Map view unavailable" : "No live GPS tracks yet";
      legend.innerHTML = "";
      return;
    }

    const tileStats = drawGpsLiveTiles(ctx2d, view, scheduleRender);
    for (const track of tracks) drawGpsLiveTrack(ctx2d, track, view);
    if (!tileStats.loaded && tileStats.total) {
      ctx2d.save();
      ctx2d.fillStyle = "rgba(15, 23, 40, 0.10)";
      ctx2d.fillRect(0, 0, size.width, size.height);
      ctx2d.restore();
    }
    drawGpsLiveCrosshair(ctx2d, size.width, size.height);

    const liveCount = tracks.filter((track) => track.ageMs <= 6000).length;
    const totalPoints = tracks.reduce((sum, track) => sum + track.points.length, 0);
    meta.textContent = `${liveCount}/${tracks.length} live · ${totalPoints} pts · ${formatGpsLiveMetersPerPx(view.metersPerPx)} · ${tileStats.loaded}/${tileStats.total || 0} tiles`;
    renderGpsLiveLegend(legend, tracks);
    status.hidden = true;
  };

  const unsub = store.subscribe((s) => ({ deviceList: s.deviceList, statesByDevice: s.statesByDevice }), () => {
    scheduleRender();
  });

  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(() => scheduleRender());
    resizeObserver.observe(viewport);
  } else {
    windowResizeHandler = () => scheduleRender();
    window.addEventListener("resize", windowResizeHandler);
  }

  ingestGpsLiveState(store.getState());
  scheduleRender();

  return {
    refresh: scheduleRender,
    destroy() {
      disposed = true;
      unsub();
      resizeObserver?.disconnect();
      if (windowResizeHandler) window.removeEventListener("resize", windowResizeHandler);
    }
  };
}

function renderPrimaryCaptureToggles(parent, cfg, disabled, updateSessionCfg, pendingToggles = new Map(), onToggleStart = null) {
  parent.innerHTML = "";
  const items = [
    {
      key: "imu",
      title: "Motion",
      description: "Accelerometer and gyroscope",
      isEnabled(currentCfg) {
        return !!currentCfg.streams?.imu?.enabled;
      },
      detail(currentCfg) {
        return currentCfg.streams?.imu?.enabled ? `${Number(currentCfg.streams.imu.rate_hz || 30)} Hz` : "Off";
      },
      toggle(nextCfg, value) {
        nextCfg.streams.imu.enabled = value;
        nextCfg.streams.imu.record = value;
      }
    },
    {
      key: "camera",
      title: "Camera",
      description: "Live preview frames",
      isEnabled(currentCfg) {
        return String(currentCfg.streams?.camera?.mode || "off") !== "off";
      },
      detail(currentCfg) {
        return String(currentCfg.streams?.camera?.mode || "off") !== "off" ? `${Number(currentCfg.streams.camera.fps || 10)} FPS` : "Off";
      },
      toggle(nextCfg, value) {
        nextCfg.streams.camera.mode = value ? "stream" : "off";
        nextCfg.streams.camera.record = value;
      }
    },
    {
      key: "audio",
      title: "Audio",
      description: "Microphone capture",
      isEnabled(currentCfg) {
        return !!currentCfg.streams?.audio?.enabled;
      },
      detail(currentCfg) {
        return currentCfg.streams?.audio?.enabled ? `${Number(currentCfg.streams.audio.rate_hz || 10)} Hz updates` : "Off";
      },
      toggle(nextCfg, value) {
        nextCfg.streams.audio.enabled = value;
        nextCfg.streams.audio.record = value;
      }
    },
    {
      key: "location",
      title: "Location",
      description: "GPS fixes",
      isEnabled(currentCfg) {
        return !!currentCfg.streams?.gps?.enabled;
      },
      detail(currentCfg) {
        return currentCfg.streams?.gps?.enabled ? `${Number(currentCfg.streams.gps.rate_hz || 1)} Hz` : "Off";
      },
      toggle(nextCfg, value) {
        nextCfg.streams.gps.enabled = value;
        nextCfg.streams.gps.record = value;
      }
    }
  ];

  for (const item of items) {
    const enabled = item.isEnabled(cfg);
    const isPending = pendingToggles.has(item.key);
    const pendingEnabled = pendingToggles.get(item.key);
    const nextEnabled = isPending ? !!pendingEnabled : enabled;
    const card = document.createElement("article");
    card.className = `session-capture-card ${nextEnabled ? "is-on" : "is-off"}${disabled ? " is-disabled" : ""}${isPending ? " is-pending" : ""}`;

    const copy = document.createElement("div");
    copy.className = "session-capture-copy";
    copy.innerHTML = `
      <div class="session-capture-head">
        <strong>${escapeHtml(item.title)}</strong>
        <span class="session-capture-status">${isPending ? (nextEnabled ? "Turning On" : "Turning Off") : (enabled ? "On" : "Off")}</span>
      </div>
      <span class="session-capture-desc">${escapeHtml(item.description)}</span>
      <span class="session-capture-detail mono">${escapeHtml(isPending ? "Applying..." : item.detail(cfg))}</span>
    `;

    const action = document.createElement("button");
    action.className = nextEnabled ? "btn btn-small session-capture-action" : "btn btn-alt btn-small session-capture-action";
    action.textContent = isPending ? "Working..." : (enabled ? "Turn Off" : "Turn On");
    action.disabled = !!disabled || isPending;
    action.addEventListener("click", () => {
      if (disabled || isPending) return;
      const targetEnabled = !enabled;
      onToggleStart?.(item.key, targetEnabled);
      updateSessionCfg((nextCfg) => {
        const currentEnabled = item.isEnabled(nextCfg);
        item.toggle(nextCfg, !currentEnabled);
      });
    });

    card.append(copy, action);
    parent.appendChild(card);
  }
}

function addFormSection(parent, title, description = "") {
  const section = document.createElement("section");
  section.className = "session-section";
  const head = document.createElement("div");
  head.className = "session-section-title";
  head.textContent = title;
  const desc = document.createElement("div");
  desc.className = "session-section-desc";
  desc.textContent = description;
  const body = document.createElement("div");
  body.className = "session-section-body";
  section.append(head, desc, body);
  parent.appendChild(section);
  return body;
}
function describeCapturePlan(cfg) {
  const items = [];
  if (cfg.streams?.imu?.enabled) items.push("motion");
  if (cfg.streams?.camera?.mode === "stream") items.push("camera");
  if (cfg.streams?.audio?.enabled) items.push("audio");
  if (cfg.streams?.gps?.enabled) items.push("location");
  return items.length ? items : ["nothing yet"];
}
function computeSessionEstimates(cfg) {
  const s = cfg.streams || {};
  const imuHz = s.imu?.enabled ? Number(s.imu.rate_hz || 30) : 0;
  const audioHz = s.audio?.enabled ? Number(s.audio.rate_hz || 10) : 0;
  const camFps = s.camera?.mode === "stream" ? Number(s.camera.fps || 10) : 0;

  // Rough transport estimate for planning only.
  const imuBytesPerSample = 72;
  const audioBytesPerSample = 64;
  const jpegKbPerFrame = 45;

  const bytesPerSec =
    (imuHz * imuBytesPerSample) +
    (audioHz * audioBytesPerSample) +
    (camFps * jpegKbPerFrame * 1024);

  const bandwidthMbps = (bytesPerSec * 8) / 1_000_000;
  const storageMbPerMin = (bytesPerSec * 60) / (1024 * 1024);
  return { bandwidthMbps, storageMbPerMin };
}

function computeSessionPreflight(st, cfg) {
  const connected = (st.deviceList || []).filter((d) => d?.connected !== false);
  const items = [];
  if (!connected.length) {
    items.push({ severity: "warn", message: "No devices are online. Recording cannot start until at least one phone is connected." });
    return items;
  }
  const activeImu = connected.filter((d) => Number(d.imuHz ?? d.imu_hz ?? 0) > 0.5).length;
  const activeCam = connected.filter((d) => Number(d.camFps ?? d.camera_fps ?? 0) > 0.5 || !!d.cameraPreviewLive).length;
  const gpsOk = connected.filter((d) => {
    const gpsTs = Number(st.statesByDevice?.[d.device_id]?.gps_latest?.t_recv_ms || 0);
    return gpsTs && (Date.now() - gpsTs) < 12000;
  }).length;
  const alertDevices = connected.filter((d) => Array.isArray(d.healthAlerts) && d.healthAlerts.length).length;

  if (cfg.streams.imu.enabled && activeImu < connected.length) {
    items.push({ severity: "warn", message: `IMU is enabled but only ${activeImu}/${connected.length} devices are sending motion data.` });
  }
  if (cfg.streams.camera.mode === "stream" && activeCam < connected.length) {
    items.push({ severity: "warn", message: `Camera is enabled but only ${activeCam}/${connected.length} devices are sending camera frames or live preview.` });
  }
  if (cfg.streams.gps.enabled && gpsOk < connected.length) {
    items.push({ severity: "warn", message: `GPS is enabled but only ${gpsOk}/${connected.length} devices have a recent fix.` });
  }
  if (alertDevices > 0) {
    items.push({ severity: "warn", message: `${alertDevices} connected device${alertDevices > 1 ? "s" : ""} currently have active health alerts.` });
  }
  return items;
}

function preflightHeadline(message) {
  const text = String(message || "").toLowerCase();
  if (text.includes("imu") || text.includes("motion")) return "Motion data needs attention";
  if (text.includes("camera")) return "Camera feed needs attention";
  if (text.includes("gps")) return "Location data needs attention";
  if (text.includes("health alert")) return "Device warnings detected";
  if (text.includes("no devices")) return "No phones connected";
  return "Check session readiness";
}

function kv(parent, k, v) {
  const d = document.createElement("div");
  d.className = "kv-item";
  d.innerHTML = `<span class="muted mono">${escapeHtml(k)}</span><strong>${escapeHtml(String(v))}</strong>`;
  parent.appendChild(d);
}

function mkBtn(label, handler, extra = "") {
  const b = document.createElement("button");
  b.className = `btn ${extra}`.trim();
  b.textContent = label;
  b.addEventListener("click", handler);
  return b;
}

function addToggle(parent, label, value, onChange, disabled = false) {
  const wrap = document.createElement("label");
  wrap.className = "toggle-line";
  const ui = document.createElement("span");
  ui.className = "toggle-check";
  const text = document.createElement("span");
  text.className = "toggle-label";
  text.textContent = label;
  const state = document.createElement("span");
  state.className = "toggle-state";
  state.textContent = value ? "On" : "Off";

  function sync(next) {
    wrap.classList.toggle("is-on", !!next);
    wrap.classList.toggle("is-disabled", !!disabled);
    state.textContent = next ? "On" : "Off";
  }

  wrap.setAttribute("role", "switch");
  wrap.setAttribute("tabindex", disabled ? "-1" : "0");
  wrap.setAttribute("aria-checked", value ? "true" : "false");
  wrap.setAttribute("aria-disabled", disabled ? "true" : "false");

  function toggle() {
    if (disabled) return;
    const next = wrap.getAttribute("aria-checked") !== "true";
    wrap.setAttribute("aria-checked", next ? "true" : "false");
    sync(next);
    onChange(next);
  }

  wrap.addEventListener("click", (event) => {
    event.preventDefault();
    toggle();
  });
  wrap.addEventListener("keydown", (event) => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      toggle();
    }
  });

  wrap.append(ui, text, state);
  sync(!!value);
  parent.appendChild(wrap);
}

function addSelect(parent, label, value, options, onChange, disabled = false) {
  const wrap = document.createElement("label");
  wrap.textContent = label;
  const sel = document.createElement("select");
  for (const o of options) {
    const opt = document.createElement("option");
    if (typeof o === "object" && o) {
      opt.value = String(o.value);
      opt.textContent = String(o.label ?? o.value);
    } else {
      opt.value = String(o);
      opt.textContent = String(o);
    }
    sel.appendChild(opt);
  }
  sel.value = String(value);
  sel.disabled = !!disabled;
  sel.addEventListener("change", () => onChange(sel.value));
  wrap.appendChild(sel);
  parent.appendChild(wrap);
}

function addTextInput(parent, label, value, onChange, disabled = false, placeholder = "") {
  const wrap = document.createElement("label");
  wrap.textContent = label;
  const input = document.createElement("input");
  input.type = "text";
  input.value = String(value || "");
  input.placeholder = placeholder;
  input.disabled = !!disabled;
  input.maxLength = 12;
  input.addEventListener("change", () => {
    input.value = String(input.value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    onChange(input.value);
  });
  wrap.appendChild(input);
  parent.appendChild(wrap);
}

function addInfoLine(parent, text) {
  const line = document.createElement("div");
  line.className = "session-info-line muted";
  line.textContent = text;
  parent.appendChild(line);
}
