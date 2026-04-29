const fs = require("fs");
const path = require("path");
const { DATASETS_ROOT, DEFAULT_RUN_CONFIG } = require("../config");
const { ImuRecorder } = require("./recorders/imu_recorder");
const { CameraRecorder } = require("./recorders/camera_recorder");
const { EventsRecorder } = require("./recorders/events_recorder");
const { NetRecorder } = require("./recorders/net_recorder");
const { AudioRecorder } = require("./recorders/audio_recorder");
const { AudioWavRecorder } = require("./recorders/audio_wav_recorder");
const { GpsRecorder } = require("./recorders/gps_recorder");
const { DeviceRecorder } = require("./recorders/device_recorder");
const { FusionRecorder } = require("./recorders/fusion_recorder");
const { ServerHealthRecorder } = require("./recorders/server_health_recorder");
const { convertSessionCsvToParquet } = require("./parquet/converter");

class SessionManager {
  constructor() {
    this.active = false;
    this.sessionDir = null;
    this.devicesRoot = null;
    this.controlLogPath = null;
    this.mode = "focused";
    this.targetDeviceIds = new Set();
    this.deviceConfigs = new Map();
    this.recordersByDevice = new Map();
    this._serverHealthRecorder = null;
  }

  start({ mode, focusedDeviceId, devicesConfigMap, extraMeta = {} }) {
    if (this.active) return { active: true, sessionDir: this.sessionDir };
    fs.mkdirSync(DATASETS_ROOT, { recursive: true });
    const stamp = formatStamp(new Date());
    this.sessionDir = path.join(DATASETS_ROOT, `session_${stamp}`);
    this.devicesRoot = path.join(this.sessionDir, "devices");
    this.controlLogPath = path.join(this.sessionDir, "control_log.jsonl");
    fs.mkdirSync(this.devicesRoot, { recursive: true });

    this.active = true;
    this.mode = mode === "all" ? "all" : "focused";
    this.targetDeviceIds = new Set(
      this.mode === "all" ? [...devicesConfigMap.keys()] : focusedDeviceId ? [focusedDeviceId] : []
    );
    this.deviceConfigs = new Map(devicesConfigMap);
    for (const deviceId of this.targetDeviceIds) {
      const safeId = sanitizeDeviceId(deviceId);
      fs.mkdirSync(path.join(this.devicesRoot, safeId, "streams"), { recursive: true });
    }

    const meta = {
      created_at_iso: new Date().toISOString(),
      start_time_iso: new Date().toISOString(),
      recording_mode: this.mode,
      focused_device_id: focusedDeviceId || null,
      target_device_ids: [...this.targetDeviceIds],
      dataset_format: { canonical: "parquet", csv_compat: DEFAULT_RUN_CONFIG.parquet?.keep_csv_compat !== false },
      devices: Object.fromEntries(
        [...devicesConfigMap.entries()].map(([id, cfg]) => [id, { runConfig: cfg }])
      ),
      ...extraMeta
    };
    fs.writeFileSync(path.join(this.sessionDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
    this.logControl({
      type: "record_start",
      mode: this.mode,
      t0_server_ms: Date.now(),
      at_iso: new Date().toISOString(),
      target_device_ids: [...this.targetDeviceIds]
    });
    return { active: true, sessionDir: this.sessionDir };
  }

  stop() {
    if (!this.active) return { active: false, sessionDir: null };
    const activeControlLogPath = this.controlLogPath;
    const recorderEntries = [...this.recordersByDevice.entries()];
    const configMap = new Map(this.deviceConfigs);
    const finalizeTasks = [];
    const stoppedDir = this.sessionDir;

    this.logControl({
      type: "record_stop",
      t1_server_ms: Date.now(),
      at_iso: new Date().toISOString()
    });
    this.active = false;
    this.sessionDir = null;
    this.devicesRoot = null;
    this.controlLogPath = null;
    this.targetDeviceIds.clear();
    this.deviceConfigs.clear();
    this.recordersByDevice.clear();

    for (const [deviceId, rec] of recorderEntries) {
      if (rec.camera) {
        const cameraCfg = configMap.get(deviceId)?.streams?.camera || {};
        const encodeTiming = cameraCfg.encode_timing || "post_session";
        const fps = cameraCfg.video_fps || cameraCfg.fps || 10;
        const cameraTask = rec.camera
          .finalize({
            fps,
            encodeTiming,
            bitrate: cameraCfg.video_bitrate || "2M",
            crf: Number.isFinite(cameraCfg.video_crf) ? cameraCfg.video_crf : 23,
            ffmpegBin: process.env.FFMPEG_BIN || "ffmpeg",
            forcePostSessionMp4: cameraCfg.auto_mp4_on_stop !== false
          })
          .then((result) => {
            appendControlLog(activeControlLogPath, {
              type: "camera_finalize",
              device_id: deviceId,
              at_iso: new Date().toISOString(),
              result
            });
            return { device_id: deviceId, kind: "camera", result };
          })
          .catch((err) => ({
            device_id: deviceId,
            kind: "camera",
            result: { ok: false, error: String(err?.message || err) }
          }));
        finalizeTasks.push(cameraTask);
      }
      if (rec.audioWav) {
        const result = rec.audioWav.finalize();
        appendControlLog(activeControlLogPath, {
          type: "audio_wav_finalize",
          device_id: deviceId,
          at_iso: new Date().toISOString(),
          result
        });
      }
    }


    const parquetCfg = DEFAULT_RUN_CONFIG.parquet || {};
    if (parquetCfg.enabled !== false) {
      convertSessionCsvToParquet({
        sessionDir: stoppedDir,
        pythonBin: process.env.PARQUET_PYTHON_BIN || parquetCfg.python_bin || "python"
      }).then((result) => {
        appendControlLog(activeControlLogPath, {
          type: "parquet_convert",
          at_iso: new Date().toISOString(),
          result
        });
      });
    }
    return {
      active: false,
      sessionDir: stoppedDir,
      stoppedDeviceIds: recorderEntries.map(([deviceId]) => deviceId),
      finalizeTasks
    };
  }

  updateDeviceConfig(deviceId, runConfig) {
    this.deviceConfigs.set(deviceId, clone(runConfig));
    if (!this.active) return;
    this.logControl({
      type: "set_config",
      device_id: deviceId,
      at_iso: new Date().toISOString(),
      runConfig
    });
  }

  logControl(entry) {
    if (!this.active || !this.controlLogPath) return;
    appendControlLog(this.controlLogPath, entry);
  }

  writeImu(deviceId, sample) {
    const cfg = this.getConfig(deviceId);
    if (!cfg?.streams?.imu?.record) return;
    this.getRecorders(deviceId).imu ??= new ImuRecorder(path.join(this.getStreamsDir(deviceId), "imu.csv"));
    this.getRecorders(deviceId).imu.write(sample);
  }

  writeCamera(deviceId, frame) {
    const cfg = this.getConfig(deviceId);
    const c = cfg?.streams?.camera;
    if (!c?.record || c.mode !== "stream") return;
    this.getRecorders(deviceId).camera ??= new CameraRecorder(this.getStreamsDir(deviceId));
    this.getRecorders(deviceId).camera.writeFrame({
      ...frame,
      record_mode: c.record_mode || "both",
      encode_timing: c.encode_timing || "post_session",
      fps: c.video_fps || c.fps || 10,
      bitrate: c.video_bitrate || "2M",
      crf: Number.isFinite(c.video_crf) ? c.video_crf : 23,
      ffmpegBin: process.env.FFMPEG_BIN || "ffmpeg",
    });
  }

  writeCameraVideoChunk(deviceId, chunk) {
    const cfg = this.getConfig(deviceId);
    const c = cfg?.streams?.camera;
    if (!c?.record || c.mode !== "stream") return;
    this.getRecorders(deviceId).camera ??= new CameraRecorder(this.getStreamsDir(deviceId));
    this.getRecorders(deviceId).camera.writeVideoChunk({
      ...chunk,
      record_mode: c.record_mode || "both"
    });
  }

  writeEvent(deviceId, evt) {
    const cfg = this.getConfig(deviceId);
    if (!cfg?.streams?.events?.record) return;
    this.getRecorders(deviceId).events ??= new EventsRecorder(path.join(this.getStreamsDir(deviceId), "events.csv"));
    this.getRecorders(deviceId).events.write(evt);
  }

  writeNet(deviceId, sample) {
    const cfg = this.getConfig(deviceId);
    if (!cfg?.streams?.net?.record) return;
    this.getRecorders(deviceId).net ??= new NetRecorder(path.join(this.getStreamsDir(deviceId), "net.csv"));
    this.getRecorders(deviceId).net.write(sample);
  }

  writeServerHealth(sample) {
    if (!this.active || !this.sessionDir) return;
    this._serverHealthRecorder ??= new ServerHealthRecorder(path.join(this.sessionDir, "server_health.csv"));
    this._serverHealthRecorder.write(sample);
  }

  writeGps(deviceId, sample) {
    const cfg = this.getConfig(deviceId);
    if (!cfg?.streams?.gps?.record) return;
    this.getRecorders(deviceId).gps ??= new GpsRecorder(path.join(this.getStreamsDir(deviceId), "gps.csv"));
    this.getRecorders(deviceId).gps.write(sample);
  }

  writeAudio(deviceId, sample) {
    const cfg = this.getConfig(deviceId);
    if (!cfg?.streams?.audio?.record) return;
    this.getRecorders(deviceId).audio ??= new AudioRecorder(path.join(this.getStreamsDir(deviceId), "audio.csv"));
    this.getRecorders(deviceId).audio.write(sample);
  }

  writeAudioPcm(deviceId, sample) {
    const cfg = this.getConfig(deviceId);
    if (!cfg?.streams?.audio?.record) return;
    this.getRecorders(deviceId).audioWav ??= new AudioWavRecorder(path.join(this.getStreamsDir(deviceId), "audio.wav"));
    this.getRecorders(deviceId).audioWav.writeChunk(sample);
  }

  writeDevice(deviceId, sample) {
    const cfg = this.getConfig(deviceId);
    if (!cfg?.streams?.device?.record) return;
    this.getRecorders(deviceId).device ??= new DeviceRecorder(path.join(this.getStreamsDir(deviceId), "device.csv"));
    this.getRecorders(deviceId).device.write(sample);
  }

  writeFusion(deviceId, sample) {
    const cfg = this.getConfig(deviceId);
    if (!cfg?.streams?.fusion?.record) return;
    this.getRecorders(deviceId).fusion ??= new FusionRecorder(path.join(this.getStreamsDir(deviceId), "fusion.csv"));
    this.getRecorders(deviceId).fusion.write(sample);
  }

  shouldRecordDevice(deviceId) {
    return this.active && this.targetDeviceIds.has(deviceId);
  }

  getConfig(deviceId) {
    if (!this.shouldRecordDevice(deviceId)) return null;
    return this.deviceConfigs.get(deviceId) || null;
  }

  getStreamsDir(deviceId) {
    const safeId = sanitizeDeviceId(deviceId);
    const dir = path.join(this.devicesRoot, safeId, "streams");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }


  getActiveRecorderFlags(deviceId) {
    const rec = this.recordersByDevice.get(deviceId);
    if (!rec) {
      return {
        imu: false,
        camera: false,
        audio: false,
        audioWav: false,
        gps: false,
        device: false,
        events: false,
        net: false,
        fusion: false
      };
    }
    return {
      imu: !!rec.imu,
      camera: !!rec.camera,
      audio: !!rec.audio,
      audioWav: !!rec.audioWav,
      gps: !!rec.gps,
      device: !!rec.device,
      events: !!rec.events,
      net: !!rec.net,
      fusion: !!rec.fusion
    };
  }
  getRecorders(deviceId) {
    if (!this.recordersByDevice.has(deviceId)) {
      this.recordersByDevice.set(deviceId, {
        imu: null,
        camera: null,
        events: null,
        net: null,
        gps: null,
        audio: null,
        audioWav: null,
        device: null,
        fusion: null
      });
    }
    return this.recordersByDevice.get(deviceId);
  }

  async encodeSessionDeviceVideo(deviceId, options = {}) {
    const rec = this.recordersByDevice.get(deviceId);
    if (!rec?.camera) return { ok: false, error: "camera recorder not active in this process" };
    const cfg = this.deviceConfigs.get(deviceId)?.streams?.camera || {};
    const result = await rec.camera.encodeNow({
      fps: cfg.video_fps || cfg.fps || 10,
      bitrate: cfg.video_bitrate || "2M",
      crf: Number.isFinite(cfg.video_crf) ? cfg.video_crf : 23,
      ffmpegBin: process.env.FFMPEG_BIN || "ffmpeg",
      ...options
    });
    if (this.controlLogPath) {
      appendControlLog(this.controlLogPath, {
        type: "manual_encode",
        device_id: deviceId,
        at_iso: new Date().toISOString(),
        result
      });
    }
    return result;
  }
}

function sanitizeDeviceId(deviceId) {
  return String(deviceId || "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
}

function formatStamp(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}_${hh}${mi}${ss}`;
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function appendControlLog(controlLogPath, entry) {
  if (!controlLogPath) return;
  try {
    fs.appendFileSync(controlLogPath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {}
}

module.exports = {
  SessionManager
};













