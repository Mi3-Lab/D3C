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
    fs.writeFileSync(this.timestampsPath, "index,filename,t_device_ms,t_recv_ms\n", "utf8");
    this.initialized = true;
  }

  writeFrame({ jpegBuffer, t_device_ms, t_recv_ms, record_mode = "jpg", encode_timing = "post_session", fps = 10, bitrate = "2M", crf = 23, ffmpegBin = "ffmpeg" }) {
    this.ensureInit(record_mode);
    this.frameIndex += 1;
    const filename = `${String(this.frameIndex).padStart(6, "0")}.jpg`;
    const jpgPath = path.join(this.cameraDir, filename);
    fs.writeFileSync(jpgPath, jpegBuffer);
    fs.appendFileSync(
      this.timestampsPath,
      `${this.frameIndex},${filename},${t_device_ms},${t_recv_ms}\n`,
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

  async finalize({ fps, ffmpegBin = "ffmpeg", encodeTiming = "post_session", bitrate = "2M", crf = 23, cleanupAfterEncode = false }) {
    if (!this.initialized) return { ok: true, skipped: true };

    const shouldEncodeVideo = this.mode === "video" || this.mode === "both";
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
    return new Promise((resolve) => {
      const inputPattern = path.join(this.cameraDir, "%06d.jpg");
      const args = [
        "-y",
        "-framerate",
        String(Math.max(1, Number(fps || 10))),
        "-i",
        inputPattern,
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

      const proc = spawn(ffmpegBin, args, { windowsHide: true });
      let stderr = "";
      proc.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      proc.on("error", (err) => {
        resolve({ ok: false, error: err.message });
      });
      proc.on("close", (code) => {
        if (code !== 0) {
          resolve({ ok: false, error: `ffmpeg exit ${code}: ${stderr.slice(-400)}` });
          return;
        }
        resolve({ ok: true, skipped: false, videoPath: this.videoPath });
      });
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
  CameraRecorder
};
