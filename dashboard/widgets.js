import { escapeHtml, formatElapsed, formatTs, parseImuCsv, parseCameraTsCsv, parseEventsCsv } from "./store.js";

export function deviceSettingSchema() {
  return { key: "device_id", type: "device", label: "Device" };
}

export function resolveWidgetDevice(settings, state) {
  if (state.viewMode === "all") return "";
  const val = settings?.device_id;
  if (val && val !== "global") return val;
  return state.globalDeviceFilter || state.focusedDeviceId || "";
}

export function createWidgetRegistry({ store, bus, sendJson, mergeRunConfig, defaultRunConfig, loadReplaySessions }) {
  return {
    fleet_health: {
      title: "Fleet Health",
      defaults: { w: 6, h: 2, pinned: true, settings: { device_id: "global" } },
      settingsSchema: [deviceSettingSchema()],
      render(content, ctx) {
        const box = document.createElement("div");
        box.className = "kv-grid";
        content.appendChild(box);
        const unsub = store.subscribe((s) => s, () => render(box, ctx));
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

        const unsub = store.subscribe((s) => ({ list: s.deviceList, states: s.statesByDevice, viewMode: s.viewMode }), () => {
          const st = store.getState();
          tbody.innerHTML = "";
          for (const d of st.deviceList || []) {
            const s = st.statesByDevice?.[d.device_id] || {};
            const imu = Number(d.imuHz ?? d.imu_hz ?? s.net?.imu_hz ?? 0);
            const cam = Number(d.camFps ?? d.cameraFps ?? d.camera_fps ?? s.net?.camera_fps ?? 0);
            const gps = s.gps_latest;
            const audio = s.audio_latest;

            const imuTxt = imu > 0 ? `${imu.toFixed(1)} Hz` : "idle";
            const gpsTxt = gps ? `${Number(gps.lat).toFixed(5)}, ${Number(gps.lon).toFixed(5)}` : "no fix";
            const audTxt = audio ? `${Math.round(20 * Math.log10(Math.max(1e-6, Number(audio.amplitude || 0))))} dB` : "idle";
            const camTxt = cam > 0 ? `${cam.toFixed(1)} FPS` : "idle";

            const tr = document.createElement("tr");
            tr.className = st.viewMode === "focused" && (st.globalDeviceFilter || st.focusedDeviceId) === d.device_id ? "row-active" : "";
            tr.innerHTML = `<td>${escapeHtml(String(d.deviceName || d.device_id))}<div class="device-sub">${escapeHtml(d.device_id)}</div></td><td>${escapeHtml(imuTxt)}</td><td>${escapeHtml(gpsTxt)}</td><td>${escapeHtml(audTxt)}</td><td>${escapeHtml(camTxt)}</td>`;
            tr.style.cursor = "pointer";
            tr.addEventListener("click", () => {
              store.setState({ viewMode: "focused", globalDeviceFilter: d.device_id });
              sendJson({ type: "set_focus", device_id: d.device_id });
            });
            tbody.appendChild(tr);
          }
        });

        return () => unsub();
      }
    },
    device_list: {
      title: "Devices",
      defaults: { w: 3, h: 5, pinned: true, settings: {} },
      render(content) {
        const table = document.createElement("table");
        table.innerHTML = "<thead><tr><th>device</th><th>readiness</th><th>imu hz</th><th>cam fps</th><th>gps</th><th>health</th><th>dropouts</th><th>lastSeen</th></tr></thead><tbody></tbody>";
        const tbody = table.querySelector("tbody");
        content.appendChild(table);

        const unsub = store.subscribe((s) => ({ list: s.deviceList, sel: s.globalDeviceFilter, focused: s.focusedDeviceId, states: s.statesByDevice }), () => {
          const st = store.getState();
          tbody.innerHTML = "";
          if (!st.deviceList || !st.deviceList.length) {
            const tr = document.createElement("tr");
            tr.innerHTML = "<td colspan=\"8\" class=\"empty-state\">No devices connected<br><span class=\"muted\">Waiting for phones to join the session</span></td>";
            tbody.appendChild(tr);
            return;
          }
          for (const d of st.deviceList) {
            const imu = Number(d.imuHz ?? d.imu_hz ?? 0);
            const cam = Number(d.camFps ?? d.cameraFps ?? d.camera_fps ?? 0);
            const connected = d?.connected !== false;
            const streaming = connected && (imu > 0.5 || cam > 0.5);
            const tone = connected ? (streaming ? "ok" : "warn") : "bad";
            const label = tone === "ok" ? "Streaming" : tone === "warn" ? "Idle" : "Disconnected";

            const tr = document.createElement("tr");
            tr.className = d.device_id === (st.globalDeviceFilter || st.focusedDeviceId) ? "row-active" : "";
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
            tr.innerHTML = `<td><span class="device-dot ${tone}"></span><div class="device-cell"><div class="device-main">${displayName}</div><div class="device-sub">${secondaryId}</div></div></td><td><span class="readiness-badge ${readinessClass}">${escapeHtml(readiness)}</span></td><td>${imu.toFixed(1)}</td><td>${cam.toFixed(1)}</td><td><span class="gps-badge ${gpsClass}">${escapeHtml(gpsText)}</span></td><td><span class="health-badge ${healthClass}" title="${escapeHtml(healthTitle)}">${escapeHtml(healthText)}</span></td><td>${Number.isFinite(dropped) ? dropped : "-"}</td><td>${escapeHtml(lastSeen)}</td>`;
            tr.style.cursor = "pointer";
            tr.addEventListener("click", () => {
              store.setState({ globalDeviceFilter: d.device_id, viewMode: "focused" });
              sendJson({ type: "set_focus", device_id: d.device_id });
            });
            tbody.appendChild(tr);
          }
        });
        return () => unsub();
      }
    },

    stream_controls: {
      title: "Session Setup",
      defaults: { w: 5, h: 6, pinned: true, settings: {} },
      render(content) {
        content.classList.add("session-setup-panel");

        const summary = document.createElement("div");
        summary.className = "kv-grid session-kpis";

        const recRow = document.createElement("div");
        recRow.className = "row session-cta-row";
        const ctaBtn = mkBtn("Start Session Recording", () => {
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
        const timer = document.createElement("span");
        timer.className = "session-rec-timer mono";
        timer.textContent = "Recording idle";
        recRow.append(ctaBtn, timer);

        const form = document.createElement("div");
        form.className = "session-form";

        content.append(summary, recRow, form);

        let lastFormKey = "";
        const unsub = store.subscribe((s) => ({ cfg: s.sessionConfig, rec: s.recording, list: s.deviceList, state: s.sessionState }), () => {
          const st = store.getState();
          const cfg = mergeRunConfig(st.sessionConfig || defaultRunConfig);
          const isActive = (st.sessionState || "draft") === "active" || !!st.recording?.active;

          const online = (st.deviceList || []).filter((d) => d?.connected !== false).length;
          const estimates = computeSessionEstimates(cfg);

          summary.innerHTML = "";
          kv(summary, "Session State", isActive ? "Active" : "Draft");
          kv(summary, "Devices Online", String(online));
          kv(summary, "Bandwidth Estimate", `${estimates.bandwidthMbps.toFixed(2)} Mbps/device`);
          kv(summary, "Storage Estimate", `${estimates.storageMbPerMin.toFixed(1)} MB/min/device`);

          const phase = st.recording?.phase || (isActive ? "RECORDING" : "IDLE");
          const isStopping = phase === "STOPPING";
          ctaBtn.disabled = isStopping;
          ctaBtn.textContent = isActive ? "Stop Session Recording" : "Start Session Recording";
          ctaBtn.className = isActive ? "btn btn-danger" : "btn btn-success";
          timer.textContent = isStopping
            ? "Stopping and flushing buffers..."
            : (isActive ? "Recording - " + formatElapsed(st.recording?.elapsed_sec || 0) + " elapsed" : "Recording idle");

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
            gps_rate: Number(cfg.streams.gps.rate_hz || 1)
          });
          if (formKey === lastFormKey) return;
          lastFormKey = formKey;

          form.innerHTML = "";

          const imuBody = addFormSection(form, "IMU");
          addToggle(imuBody, "Enable IMU", cfg.streams.imu.enabled, (v) => updateSessionCfg(cfg, (c) => {
            c.streams.imu.enabled = v;
            c.streams.imu.record = v;
          }), isActive);
          if (cfg.streams.imu.enabled) {
            addSelect(imuBody, "IMU rate", String(cfg.streams.imu.rate_hz || 30), ["10", "30", "60"], (v) => updateSessionCfg(cfg, (c) => c.streams.imu.rate_hz = Number(v)), isActive);
          }

          const camBody = addFormSection(form, "Camera");
          addToggle(camBody, "Enable Camera", cfg.streams.camera.mode !== "off", (v) => updateSessionCfg(cfg, (c) => {
            c.streams.camera.mode = v ? "stream" : "off";
            c.streams.camera.record = v;
          }), isActive);
          if (cfg.streams.camera.mode !== "off") {
            addSelect(camBody, "Camera mode", String(cfg.streams.camera.mode || "stream"), ["off", "stream"], (v) => updateSessionCfg(cfg, (c) => {
              c.streams.camera.mode = v;
              c.streams.camera.record = v === "stream";
            }), isActive);
            addSelect(camBody, "Camera FPS", String(cfg.streams.camera.fps || 10), ["5", "10", "15", "30"], (v) => updateSessionCfg(cfg, (c) => c.streams.camera.fps = Number(v)), isActive);
          }

          const audioBody = addFormSection(form, "Audio");
          addToggle(audioBody, "Enable Audio", cfg.streams.audio.enabled, (v) => updateSessionCfg(cfg, (c) => {
            c.streams.audio.enabled = v;
            c.streams.audio.record = v;
          }), isActive);
          if (cfg.streams.audio.enabled) {
            addSelect(audioBody, "Audio rate", String(cfg.streams.audio.rate_hz || 10), ["5", "10", "20"], (v) => updateSessionCfg(cfg, (c) => c.streams.audio.rate_hz = Number(v)), isActive);
          }
          
          const gpsBody = addFormSection(form, "GPS");
          addToggle(gpsBody, "Enable GPS", cfg.streams.gps.enabled, (v) => updateSessionCfg(cfg, (c) => {
            c.streams.gps.enabled = v;
            c.streams.gps.record = v;
          }), isActive);
          if (cfg.streams.gps.enabled) {
            addSelect(gpsBody, "GPS rate", String(cfg.streams.gps.rate_hz || 1), ["1", "2", "5"], (v) => updateSessionCfg(cfg, (c) => c.streams.gps.rate_hz = Number(v)), isActive);
          }
        });

        function updateSessionCfg(cfg, mutator) {
          const st = store.getState();
          const isActive = (st.sessionState || "draft") === "active" || !!st.recording?.active;
          if (isActive) return;
          const next = mergeRunConfig(cfg);
          mutator(next);
          store.setState({ sessionConfig: next, sessionState: "draft" });
          sendJson({ type: "session_config_update", sessionConfig: next });
        }

        return () => unsub();
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

        const unsub = store.subscribe((s) => s, () => {
          const st = store.getState();
          const deviceId = resolveWidgetDevice(ctx.instance.settings, st);
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
      title: "Camera Preview",
      defaults: { w: 6, h: 3, pinned: false, settings: { device_id: "global" } },
      settingsSchema: [deviceSettingSchema()],
      render(content, ctx) {
        const viewport = document.createElement("div");
        viewport.className = "camera-viewport";

        const overlay = document.createElement("div");
        overlay.className = "camera-overlay";
        const badge = document.createElement("span");
        badge.className = "camera-badge offline";
        badge.textContent = "OFFLINE";
        const meta = document.createElement("span");
        meta.className = "camera-meta";
        meta.textContent = "0.0 FPS | --x--";
        overlay.append(badge, meta);

        const img = document.createElement("img");
        img.className = "widget-image";
        img.alt = "latest camera frame";

        const placeholder = document.createElement("div");
        placeholder.className = "camera-placeholder";
        placeholder.textContent = "Camera Offline - Waiting for device stream";

        const footer = document.createElement("div");
        footer.className = "camera-footer mono";
        footer.textContent = "Device: - | RTT: -- ms";

        viewport.append(overlay, img, placeholder);
        content.append(viewport, footer);

        let resolutionText = "--x--";
        img.addEventListener("load", () => {
          if (img.naturalWidth && img.naturalHeight) {
            resolutionText = `${img.naturalWidth}x${img.naturalHeight}`;
          }
        });

        const unsub = store.subscribe((s) => s, () => {
          const st = store.getState();
          const deviceId = resolveWidgetDevice(ctx.instance.settings, st);
          const state = deviceId ? st.statesByDevice[deviceId] : null;
          const camTs = Number(state?.camera_latest_ts || 0);
          const summary = (st.deviceList || []).find((d) => d.device_id === deviceId) || null;
          const connected = summary ? summary.connected !== false : false;
          const fresh = camTs > 0 && (Date.now() - camTs) < 4000;
          const fps = Number(summary?.camFps ?? summary?.camera_fps ?? state?.net?.camera_fps ?? 0);
          const rtt = Number(summary?.rttMs ?? state?.net?.rtt_ms);
          const rec = st.recordByDevice?.[deviceId];
          const isCamRecording = !!rec?.recording && !!rec?.modalities?.cam;

          if (deviceId && fresh) {
            img.src = `/latest.jpg?device_id=${encodeURIComponent(deviceId)}&ts=${camTs}`;
          } else if (!fresh) {
            img.removeAttribute("src");
            resolutionText = "--x--";
          }

          if (!deviceId || !connected || !fresh) {
            badge.className = "camera-badge offline";
            badge.textContent = "OFFLINE";
          } else if (isCamRecording) {
            badge.className = "camera-badge rec";
            badge.textContent = "REC";
          } else {
            badge.className = "camera-badge live";
            badge.textContent = "LIVE";
          }

          meta.textContent = `${fps > 0 ? fps.toFixed(1) : "0.0"} FPS | ${resolutionText}`;
          placeholder.style.display = fresh ? "none" : "flex";

          const deviceLabel = summary?.deviceName || deviceId || "No focused device";
          const rttText = Number.isFinite(rtt) ? `${Math.round(rtt)} ms` : "-- ms";
          footer.textContent = `Device: ${deviceLabel} | RTT: ${rttText}`;
        });

        const unbus = bus.on("preview_image", (src) => {
          img.src = src;
          placeholder.style.display = "none";
        });
        return () => { unsub(); unbus(); };
      }
    },


    gps_live: {
      title: "GPS Live",
      defaults: { w: 4, h: 3, pinned: false, settings: { device_id: "global" } },
      settingsSchema: [deviceSettingSchema()],
      render(content, ctx) {
        const note = document.createElement("div");
        note.className = "mono muted";
        content.appendChild(note);

        const box = document.createElement("div");
        box.className = "kv-grid";
        content.appendChild(box);

        const table = document.createElement("table");
        table.style.display = "none";
        table.innerHTML = "<thead><tr><th>Device</th><th>Lat</th><th>Lon</th><th>Acc(m)</th><th>Age(ms)</th></tr></thead><tbody></tbody>";
        const tbody = table.querySelector("tbody");
        content.appendChild(table);

        const unsub = store.subscribe((s) => s, () => {
          const st = store.getState();
          const now = Date.now();

          if (st.viewMode === "all") {
            box.style.display = "none";
            table.style.display = "table";
            tbody.innerHTML = "";
            const list = st.deviceList || [];
            if (!list.length) {
              const tr = document.createElement("tr");
            tr.innerHTML = "<td colspan=\"7\" class=\"empty-state\">No devices connected<br><span class=\"muted\">Waiting for phones to join the session</span></td>";
              tbody.appendChild(tr);
              note.textContent = "All Devices mode";
              return;
            }

            let active = 0;
            for (const d of list) {
              const g = st.statesByDevice?.[d.device_id]?.gps_latest;
              const age = g?.t_recv_ms ? Math.max(0, now - Number(g.t_recv_ms)) : null;
              if (age != null && age < 4000) active += 1;
              const tr = document.createElement("tr");
              tr.innerHTML = `<td>${escapeHtml(String(d.deviceName || d.device_id))}</td><td>${g ? Number(g.lat).toFixed(6) : "-"}</td><td>${g ? Number(g.lon).toFixed(6) : "-"}</td><td>${g ? Number(g.accuracy_m).toFixed(1) : "-"}</td><td>${age == null ? "-" : String(age)}</td>`;
              tbody.appendChild(tr);
            }
            note.textContent = `All Devices mode | GPS active ${active}/${list.length}`;
            return;
          }

          table.style.display = "none";
          box.style.display = "grid";
          const deviceId = resolveWidgetDevice(ctx.instance.settings, st);
          const g = deviceId ? st.statesByDevice?.[deviceId]?.gps_latest : null;
          const age = g?.t_recv_ms ? Math.max(0, now - Number(g.t_recv_ms)) : null;
          note.textContent = `Device: ${deviceId || "none"}`;
          box.innerHTML = "";
          kv(box, "Status", age != null && age < 4000 ? "LIVE" : "OFFLINE");
          kv(box, "Latitude", g ? Number(g.lat).toFixed(6) : "-");
          kv(box, "Longitude", g ? Number(g.lon).toFixed(6) : "-");
          kv(box, "Accuracy (m)", g ? Number(g.accuracy_m).toFixed(1) : "-");
          kv(box, "Speed (m/s)", g ? Number(g.speed_mps).toFixed(2) : "-");
          kv(box, "Heading (deg)", g ? Number(g.heading_deg).toFixed(1) : "-");
          kv(box, "Altitude (m)", g ? Number(g.altitude_m).toFixed(1) : "-");
          kv(box, "Last Seen", age == null ? "-" : `${age} ms ago`);
        });

        return () => unsub();
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
        const allModeNote = makeAllDevicesNotice();
        const mark = mkBtn("? Tag Event", () => {
          const st = store.getState();
          const deviceId = resolveWidgetDevice(ctx.instance.settings, st);
          sendJson({ type: "event", device_id: deviceId, label: (input.value || "event").trim() });
          input.value = "";
        });
        row.append(input, mark);
        content.appendChild(row);

        const ul = document.createElement("ul");
        ul.className = "timeline";
        content.appendChild(ul);
        const unsub = store.subscribe((s) => s, () => {
          const st = store.getState();
          const deviceId = resolveWidgetDevice(ctx.instance.settings, st);
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
          const st = store.getState();
          const deviceId = resolveWidgetDevice(ctx.instance.settings, st);
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
        refresh();
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
        const unsub = store.subscribe((s) => s, () => {
          const st = store.getState();
          const deviceId = resolveWidgetDevice(ctx.instance.settings, st);
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


function makeAllDevicesNotice() {
  const el = document.createElement("p");
  el.className = "all-mode-note muted mono";
  el.textContent = "All Devices mode active - select Focused mode to inspect a single device.";
  el.style.display = "none";
  return el;
}

function setAllDevicesModeNotice(el, enabled) {
  if (!el) return;
  el.style.display = enabled ? "block" : "none";
}
function render(box, ctx) {
  const st = ctx.store.getState();
  const deviceId = resolveWidgetDevice(ctx.instance.settings, st);
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

function addFormSection(parent, title) {
  const section = document.createElement("section");
  section.className = "session-section";
  const head = document.createElement("div");
  head.className = "session-section-title";
  head.textContent = title;
  const body = document.createElement("div");
  body.className = "session-section-body";
  section.append(head, body);
  parent.appendChild(section);
  return body;
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
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = !!value;
  cb.disabled = !!disabled;
  cb.addEventListener("change", () => onChange(cb.checked));
  wrap.append(cb, document.createTextNode(` ${label}`));
  parent.appendChild(wrap);
}

function addSelect(parent, label, value, options, onChange, disabled = false) {
  const wrap = document.createElement("label");
  wrap.textContent = label;
  const sel = document.createElement("select");
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = String(o);
    opt.textContent = String(o);
    sel.appendChild(opt);
  }
  sel.value = String(value);
  sel.disabled = !!disabled;
  sel.addEventListener("change", () => onChange(sel.value));
  wrap.appendChild(sel);
  parent.appendChild(wrap);
}




































