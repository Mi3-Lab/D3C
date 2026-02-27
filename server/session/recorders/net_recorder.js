const fs = require("fs");

class NetRecorder {
  constructor(filePath) {
    this.filePath = filePath;
    this.initialized = false;
  }

  ensureHeader() {
    if (this.initialized) return;
    fs.writeFileSync(this.filePath, "t_recv_ms,fps,dropped_frames,rtt_ms\n", "utf8");
    this.initialized = true;
  }

  write(sample) {
    this.ensureHeader();
    const row = `${sample.t_recv_ms},${sample.fps},${sample.dropped_frames},${sample.rtt_ms}\n`;
    fs.appendFileSync(this.filePath, row, "utf8");
  }
}

module.exports = {
  NetRecorder
};
