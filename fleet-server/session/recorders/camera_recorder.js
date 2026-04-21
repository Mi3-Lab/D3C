const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

class CameraRecorder {
  constructor(streamsDir) {
    this.cameraDir = path.join(streamsDir, "camera");
    this.timestampsPath = path.join(streamsDir, "camera_timestamps.csv");
    this.videoPath = path.join(streamsDir, "camera_video.mp4");
    this.frameIndex = 0;
    this.initialized = false;
    this.mode = "jpg";
    this.ffmpegProc = null;
    this.realtimeEncode = false;
    this.realtimeClosed = false;
  }

  ensureInit(mode = "jpg") {
    if (this.initialized) return;
    this.mode = mode;
    fs.mkdirSync(this.cameraDir, { recursive: true });
    fs.writeFileSync(this.timestampsPath, "index,filename,t_device_ms,t_recv_ms,t_server_rx_ns\n", "utf8");
    this.initialized = true;
  }

  writeFrame({ jpegBuffer, t_device_ms, t_recv_ms, t_server_rx_ns = "", record_mode = "jpg", encode_timing = "post_session", fps = 10, bitrate = "2M", crf = 23, ffmpegBin = "ffmpeg" }) {
    this.ensureInit(record_mode);
    this.frameIndex += 1;
    const filename = `${String(this.frameIndex).padStart(6, "0")}.jpg`;
    const jpgPath = path.join(this.cameraDir, filename);
    fs.writeFileSync(jpgPath, jpegBuffer);
    fs.appendFileSync(
      this.timestampsPath,
      `${this.frameIndex},${filename},${t_device_ms},${t_recv_ms},${t_server_rx_ns}\n`,
      "utf8"
    );

    const wantsVideo = this.mode === "video" || this.mode === "both";
    const wantsRealtime = encode_timing === "realtime";
    if (wantsVideo && wantsRealtime) {
      this.ensureRealtimeEncoder({ fps, bitrate, crf, ffmpegBin });
      if (this.ffmpegProc && !this.realtimeClosed) {
        try {
          this.ffmpegProc.stdin.write(jpegBuffer);
        } catch {
          this.realtimeClosed = true;
        }
      }
    }
  }

  ensureRealtimeEncoder({ fps, bitrate, crf, ffmpegBin }) {
    if (this.ffmpegProc || this.realtimeClosed) return;
    const safeFps = Math.max(1, Number(fps || 10));
    const args = [
      "-y",
      "-f",
      "image2pipe",
      "-vcodec",
      "mjpeg",
      "-framerate",
      String(safeFps),
      "-i",
      "-",
      ...buildH264Mp4VideoArgs({
        fps: safeFps,
        bitrate,
        crf,
        tune: "zerolatency"
      }),
      this.videoPath
    ];
    this.realtimeEncode = true;
    this.ffmpegProc = spawn(ffmpegBin, args, { windowsHide: true });
    this.ffmpegProc.on("error", () => {
      this.realtimeClosed = true;
      this.ffmpegProc = null;
    });
    this.ffmpegProc.on("close", () => {
      this.realtimeClosed = true;
      this.ffmpegProc = null;
    });
  }

  async finalize({
    fps,
    ffmpegBin = "ffmpeg",
    encodeTiming = "post_session",
    bitrate = "2M",
    crf = 23,
    cleanupAfterEncode = false,
    forcePostSessionMp4 = false
  }) {
    if (!this.initialized) return { ok: true, skipped: true };

    const shouldEncodeVideo = forcePostSessionMp4 || this.mode === "video" || this.mode === "both";
    if (!shouldEncodeVideo) return { ok: true, skipped: true };
    if (!this.frameIndex) return { ok: true, skipped: true };

    if (encodeTiming === "manual") {
      return { ok: true, skipped: true, reason: "manual" };
    }

    if (this.realtimeEncode) {
      const res = await this.closeRealtimeEncoder();
      if (!res.ok) return res;
      return { ok: true, skipped: false, videoPath: this.videoPath, mode: "realtime" };
    }

    const result = await this.encodeFromJpgSequence({ fps, ffmpegBin, bitrate, crf });
    if (result.ok && cleanupAfterEncode && this.mode === "video") {
      safeRemoveDir(this.cameraDir);
    }
    return result;
  }

  closeRealtimeEncoder() {
    return new Promise((resolve) => {
      if (!this.ffmpegProc || this.realtimeClosed) {
        return resolve({ ok: fs.existsSync(this.videoPath), skipped: !fs.existsSync(this.videoPath), videoPath: this.videoPath });
      }
      const proc = this.ffmpegProc;
      let stderr = "";
      proc.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      proc.on("close", (code) => {
        this.realtimeClosed = true;
        this.ffmpegProc = null;
        if (code !== 0) {
          return resolve({ ok: false, error: `ffmpeg exit ${code}: ${stderr.slice(-400)}` });
        }
        resolve({ ok: true, skipped: false, videoPath: this.videoPath });
      });
      try {
        proc.stdin.end();
      } catch {
        resolve({ ok: false, error: "failed closing realtime ffmpeg stdin" });
      }
    });
  }

  encodeFromJpgSequence({ fps, ffmpegBin = "ffmpeg", bitrate = "2M", crf = 23 }) {
    return encodeCameraDirToMp4({
      cameraDir: this.cameraDir,
      timestampsPath: this.timestampsPath,
      outMp4: this.videoPath,
      fps,
      ffmpegBin,
      bitrate,
      crf
    });
  }

  encodeNow(options = {}) {
    return this.encodeFromJpgSequence({ ...options });
  }
}

function safeRemoveDir(dirPath) {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {}
}

module.exports = {
  CameraRecorder,
  encodeCameraDirToMp4
};

function encodeCameraDirToMp4({ cameraDir, timestampsPath, outMp4, fps, ffmpegBin = "ffmpeg", bitrate = "2M", crf = 23, timelineRows = null }) {
  const resolvedCameraDir = path.resolve(cameraDir);
  const resolvedOutMp4 = path.resolve(outMp4);
  const safeFps = Math.max(1, Number(fps || 10));
  const timing = buildResampledFrameSequence({ cameraDir, timestampsPath, outputFps: safeFps, timelineRows });
  const args = timing?.sequenceDir
    ? [
        "-y",
        "-framerate",
        String(safeFps),
        "-i",
        path.join(timing.sequenceDir, "%06d.jpg"),
        ...buildH264Mp4VideoArgs({ fps: safeFps, bitrate, crf }),
        resolvedOutMp4
      ]
    : [
        "-y",
        "-framerate",
        String(safeFps),
        "-i",
        path.join(resolvedCameraDir, "%06d.jpg"),
        ...buildH264Mp4VideoArgs({ fps: safeFps, bitrate, crf }),
        resolvedOutMp4
      ];

  return new Promise((resolve) => {
    const proc = spawn(ffmpegBin, args, { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", (err) => {
      cleanupTimingManifest(timing);
      resolve({ ok: false, error: err.message });
    });
    proc.on("close", (code) => {
      cleanupTimingManifest(timing);
      if (code !== 0) {
        resolve({ ok: false, error: `ffmpeg exit ${code}: ${stderr.slice(-400)}` });
        return;
      }
      resolve({
        ok: true,
        skipped: false,
        videoPath: resolvedOutMp4,
        timing_mode: timing ? "timestamped" : "fixed_fps",
        timing_source: timing?.source || null
      });
    });
  });
}

function buildH264Mp4VideoArgs({ fps, bitrate = "2M", crf = 23, tune = "" } = {}) {
  const safeFps = Math.max(1, Number(fps || 10));
  const safeCrf = Number.isFinite(crf) ? Number(crf) : 23;
  const gop = Math.max(12, Math.round(safeFps * 2));
  const minKeyint = Math.max(1, Math.round(safeFps));
  const args = [
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-b:v",
    String(bitrate || "2M"),
    "-crf",
    String(safeCrf),
    "-g",
    String(gop),
    "-keyint_min",
    String(minKeyint),
    "-sc_threshold",
    "0",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart"
  ];
  if (tune) args.splice(8, 0, "-tune", String(tune));
  return args;
}

function buildResampledFrameSequence({ cameraDir, timestampsPath, outputFps, timelineRows = null }) {
  try {
    const resolvedCameraDir = path.resolve(cameraDir);
    let rows = null;
    let chosen = null;
    if (Array.isArray(timelineRows) && timelineRows.length >= 2) {
      rows = timelineRows
        .filter((row) => row?.filename && Number.isFinite(row.timelineMs))
        .map((row) => ({ ...row }));
      if (rows.length >= 2) {
        chosen = buildMonotonicTimeline(rows, "external_timeline_ms", (row) => row.timelineMs);
      }
    }
    if (!chosen) {
      const resolvedTimestampsPath = path.resolve(timestampsPath);
      if (!timestampsPath || !fs.existsSync(resolvedTimestampsPath)) return null;
      const lines = fs.readFileSync(resolvedTimestampsPath, "utf8").trim().split(/\r?\n/).slice(1);
      if (lines.length < 2) return null;
      rows = lines.map(parseTimestampRow).filter(Boolean);
      if (rows.length < 2) return null;
      chosen = chooseTimeline(rows);
    }
    if (rows.length < 2) return null;
    if (!chosen) return null;

    const safeOutputFps = Math.max(1, Number(outputFps || 10));
    const startMs = chosen.values[0];
    const endMs = chosen.values[chosen.values.length - 1];
    const durationMs = Math.max(0, endMs - startMs);
    const outputFrameCount = Math.max(1, Math.round((durationMs / 1000) * safeOutputFps) + 1);
    const sequenceDir = path.join(resolvedCameraDir, ".camera_ffmpeg_sequence");
    safeRemoveDir(sequenceDir);
    fs.mkdirSync(sequenceDir, { recursive: true });

    let sourceIndex = 0;
    for (let outputIndex = 0; outputIndex < outputFrameCount; outputIndex += 1) {
      const targetMs = startMs + (outputIndex * 1000) / safeOutputFps;
      while (
        sourceIndex < chosen.values.length - 1 &&
        chosen.values[sourceIndex + 1] <= targetMs
      ) {
        sourceIndex += 1;
      }
      const sourcePath = path.join(resolvedCameraDir, chosen.rows[sourceIndex].filename);
      const destPath = path.join(sequenceDir, `${String(outputIndex + 1).padStart(6, "0")}.jpg`);
      try {
        fs.linkSync(sourcePath, destPath);
      } catch {
        fs.copyFileSync(sourcePath, destPath);
      }
    }

    return { sequenceDir, source: chosen.source };
  } catch {
    return null;
  }
}

function parseTimestampRow(line) {
  const parts = line.split(",");
  if (parts.length < 4) return null;
  const filename = parts[1];
  const tDeviceMs = Number(parts[2]);
  const tRecvMs = Number(parts[3]);
  const tServerRxNs = Number(parts[4]);
  if (!filename) return null;
  return {
    filename,
    tDeviceMs: Number.isFinite(tDeviceMs) ? tDeviceMs : NaN,
    tRecvMs: Number.isFinite(tRecvMs) ? tRecvMs : NaN,
    tServerRxNs: Number.isFinite(tServerRxNs) ? tServerRxNs : NaN
  };
}

function chooseTimeline(rows) {
  const candidates = [
    buildMonotonicTimeline(rows, "t_device_ms", (row) => row.tDeviceMs),
    buildMonotonicTimeline(rows, "t_server_rx_ns", (row) => row.tServerRxNs, { scale: 1 / 1000000 }),
    buildMonotonicTimeline(rows, "t_recv_ms", (row) => row.tRecvMs)
  ].filter(Boolean);

  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    if (b.values.length !== a.values.length) return b.values.length - a.values.length;
    const priority = { t_device_ms: 3, t_server_rx_ns: 2, t_recv_ms: 1 };
    return (priority[b.source] || 0) - (priority[a.source] || 0);
  });
  return candidates[0];
}

function isStrictlyIncreasing(values) {
  if (values.length < 2) return false;
  for (let i = 0; i < values.length; i += 1) {
    if (!Number.isFinite(values[i])) return false;
    if (i > 0 && values[i] <= values[i - 1]) return false;
  }
  return true;
}

function buildMonotonicTimeline(rows, source, getter, options = {}) {
  const scale = Number.isFinite(options.scale) ? options.scale : 1;
  const keptRows = [];
  const values = [];
  let lastValue = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const rawValue = getter(row);
    if (!Number.isFinite(rawValue)) continue;
    const value = rawValue * scale;
    if (!(value > lastValue)) continue;
    keptRows.push(row);
    values.push(value);
    lastValue = value;
  }
  if (values.length < 2) return null;
  return { source, rows: keptRows, values };
}

function cleanupTimingManifest(timing) {
  if (!timing?.sequenceDir) return;
  safeRemoveDir(timing.sequenceDir);
}
