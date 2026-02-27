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
  }

  ensureInit(mode = "jpg") {
    if (this.initialized) return;
    this.mode = mode;
    fs.mkdirSync(this.cameraDir, { recursive: true });
    fs.writeFileSync(this.timestampsPath, "index,filename,t_device_ms,t_recv_ms\n", "utf8");
    this.initialized = true;
  }

  writeFrame({ jpegBuffer, t_device_ms, t_recv_ms, record_mode = "jpg" }) {
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
  }

  finalize({ fps, ffmpegBin = "ffmpeg", encodeTiming = "post_session", bitrate = "2M", crf = 23, cleanupAfterEncode = false }) {
    if (!this.initialized) return Promise.resolve({ ok: true, skipped: true });
    if (encodeTiming === "manual") return Promise.resolve({ ok: true, skipped: true, reason: "manual" });
    const shouldEncodeVideo = this.mode === "video" || this.mode === "both";
    if (!shouldEncodeVideo) return Promise.resolve({ ok: true, skipped: true });
    if (!this.frameIndex) return Promise.resolve({ ok: true, skipped: true });

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
        if (cleanupAfterEncode && this.mode === "video") {
          safeRemoveDir(this.cameraDir);
        }
        resolve({ ok: true, skipped: false, videoPath: this.videoPath });
      });
    });
  }

  encodeNow(options = {}) {
    return this.finalize({ ...options, encodeTiming: "post_session" });
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
