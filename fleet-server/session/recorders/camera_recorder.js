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
    const args = [
      "-y",
      "-f",
      "image2pipe",
      "-vcodec",
      "mjpeg",
      "-framerate",
      String(Math.max(1, Number(fps || 10))),
      "-i",
      "-",
      "-c:v",
      "libx264",
      "-b:v",
      String(bitrate || "2M"),
      "-crf",
      String(Number.isFinite(crf) ? crf : 23),
      "-pix_fmt",
      "yuv420p",
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

function encodeCameraDirToMp4({ cameraDir, timestampsPath, outMp4, fps, ffmpegBin = "ffmpeg", bitrate = "2M", crf = 23 }) {
  const resolvedCameraDir = path.resolve(cameraDir);
  const resolvedOutMp4 = path.resolve(outMp4);
  const timing = buildResampledFrameSequence({ cameraDir, timestampsPath, outputFps: fps });
  const args = timing?.sequenceDir
    ? [
        "-y",
        "-framerate",
        String(Math.max(1, Number(fps || 10))),
        "-i",
        path.join(timing.sequenceDir, "%06d.jpg"),
        "-c:v",
        "libx264",
        "-b:v",
        String(bitrate || "2M"),
        "-crf",
        String(Number.isFinite(crf) ? crf : 23),
        "-pix_fmt",
        "yuv420p",
        resolvedOutMp4
      ]
    : [
        "-y",
        "-framerate",
        String(Math.max(1, Number(fps || 10))),
        "-i",
        path.join(resolvedCameraDir, "%06d.jpg"),
        "-c:v",
        "libx264",
        "-b:v",
        String(bitrate || "2M"),
        "-crf",
        String(Number.isFinite(crf) ? crf : 23),
        "-pix_fmt",
        "yuv420p",
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

function buildResampledFrameSequence({ cameraDir, timestampsPath, outputFps }) {
  try {
    const resolvedCameraDir = path.resolve(cameraDir);
    const resolvedTimestampsPath = path.resolve(timestampsPath);
    if (!timestampsPath || !fs.existsSync(resolvedTimestampsPath)) return null;
    const lines = fs.readFileSync(resolvedTimestampsPath, "utf8").trim().split(/\r?\n/).slice(1);
    if (lines.length < 2) return null;
    const rows = lines.map(parseTimestampRow).filter(Boolean);
    if (rows.length < 2) return null;

    const chosen = chooseTimeline(rows);
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
      const sourcePath = path.join(resolvedCameraDir, rows[sourceIndex].filename);
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
  if (!filename) return null;
  return {
    filename,
    tDeviceMs: Number.isFinite(tDeviceMs) ? tDeviceMs : NaN,
    tRecvMs: Number.isFinite(tRecvMs) ? tRecvMs : NaN
  };
}

function chooseTimeline(rows) {
  const deviceValues = rows.map((r) => r.tDeviceMs);
  if (isStrictlyIncreasing(deviceValues)) {
    return { source: "t_device_ms", values: deviceValues };
  }
  const recvValues = rows.map((r) => r.tRecvMs);
  if (isStrictlyIncreasing(recvValues)) {
    return { source: "t_recv_ms", values: recvValues };
  }
  return null;
}

function isStrictlyIncreasing(values) {
  if (values.length < 2) return false;
  for (let i = 0; i < values.length; i += 1) {
    if (!Number.isFinite(values[i])) return false;
    if (i > 0 && values[i] <= values[i - 1]) return false;
  }
  return true;
}

function cleanupTimingManifest(timing) {
  if (!timing?.sequenceDir) return;
  safeRemoveDir(timing.sequenceDir);
}
