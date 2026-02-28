import { escapeHtml, formatElapsed, formatTs, parseImuCsv, parseCameraTsCsv, parseEventsCsv } from "./store.js";

export function deviceSettingSchema() {
  return { key: "device_id", type: "device", label: "Device" };
}

export function resolveWidgetDevice(settings, state) {
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

    device_list: {
      title: "Devices",
      defaults: { w: 3, h: 5, pinned: true, settings: {} },
      render(content) {
        const table = document.createElement("table");
        table.innerHTML = "<thead><tr><th>device</th><th>readiness</th><th>imu hz</th><th>cam fps</th><th>dropouts</th><th>lastSeen</th></tr></thead><tbody></tbody>";
        const tbody = table.querySelector("tbody");
        content.appendChild(table);

        const unsub = store.subscribe((s) => ({ list: s.deviceList, sel: s.globalDeviceFilter, focused: s.focusedDeviceId }), () => {
          const st = store.getState();
          tbody.innerHTML = "";
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
            tr.innerHTML = `<td><span class="device-dot ${tone}"></span><div class="device-cell"><div class="device-main">${displayName}</div><div class="device-sub">${secondaryId}</div></div></td><td><span class="readiness-badge ${readinessClass}">${escapeHtml(readiness)}</span></td><td>${imu.toFixed(1)}</td><td>${cam.toFixed(1)}</td><td>${Number.isFinite(dropped) ? dropped : "-"}</td><td>${escapeHtml(lastSeen)}</td>`;
            tr.style.cursor = "pointer";
            tr.addEventListener("click", () => {
              store.setState({ globalDeviceFilter: d.device_id });
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
        const startBtn = mkBtn("Start Session Recording", () => {
          sendJson({
            type: "session_start",
            session_name: `session_${new Date().toISOString().replace(/[:.]/g, "-")}`
          });
        }, "btn-success");
        const stopBtn = mkBtn("Stop Session", () => {
          const st = store.getState();
          sendJson({ type: "session_stop", session_id: st.recording?.session_id || null });
        }, "btn-danger");
        recRow.append(startBtn, stopBtn);

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

          startBtn.disabled = isActive;
          stopBtn.disabled = !isActive;

          const formKey = JSON.stringify({
            active: isActive,
            imu_enabled: !!cfg.streams.imu.enabled,
            imu_rate: Number(cfg.streams.imu.rate_hz || 30),
            cam_enabled: String(cfg.streams.camera.mode || "off") !== "off",
            cam_mode: String(cfg.streams.camera.mode || "off"),
            cam_fps: Number(cfg.streams.camera.fps || 10),
            audio_enabled: !!cfg.streams.audio.enabled,
            audio_rate: Number(cfg.streams.audio.rate_hz || 10)
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
            addSelect(camBody, "Camera mode", String(cfg.streams.camera.mode || "stream"), ["preview", "stream"], (v) => updateSessionCfg(cfg, (c) => {
              c.streams.camera.mode = v;
              c.streams.camera.record = v === "stream";
            }), isActive);
            addSelect(camBody, "Camera FPS", String(cfg.streams.camera.fps || 10), ["5", "10", "15"], (v) => updateSessionCfg(cfg, (c) => c.streams.camera.fps = Number(v)), isActive);
          }

          const audioBody = addFormSection(form, "Audio");
          addToggle(audioBody, "Enable Audio", cfg.streams.audio.enabled, (v) => updateSessionCfg(cfg, (c) => {
            c.streams.audio.enabled = v;
            c.streams.audio.record = v;
          }), isActive);
          if (cfg.streams.audio.enabled) {
            addSelect(audioBody, "Audio rate", String(cfg.streams.audio.rate_hz || 10), ["5", "10", "20"], (v) => updateSessionCfg(cfg, (c) => c.streams.audio.rate_hz = Number(v)), isActive);
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
        accelTitle.textContent = "Accelerometer (m/s²)";
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
        const img = document.createElement("img");
        img.className = "widget-image";
        img.alt = "latest camera frame";
        content.appendChild(img);
        const unsub = store.subscribe((s) => s, () => {
          const st = store.getState();
          const deviceId = resolveWidgetDevice(ctx.instance.settings, st);
          const camTs = st.statesByDevice[deviceId]?.camera_latest_ts;
          if (camTs) img.src = `/latest.jpg?device_id=${encodeURIComponent(deviceId)}&ts=${camTs}`;
        });
        const unbus = bus.on("preview_image", (src) => { img.src = src; });
        return () => { unsub(); unbus(); };
      }
    },

    events_timeline: {
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
        const stop = mkBtn("¦ Stop", onStop, "btn-danger");
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















