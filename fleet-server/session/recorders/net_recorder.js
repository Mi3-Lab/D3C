const fs = require("fs");

class NetRecorder {
  constructor(filePath) {
    this.filePath = filePath;
    this.initialized = false;
  }

  ensureHeader() {
    if (this.initialized) return;
    fs.writeFileSync(this.filePath, "t_recv_ms,fps,dropped_frames,rtt_ms,t_server_rx_ns\n", "utf8");
    this.initialized = true;
  }

  write(sample) {
    this.ensureHeader();
    const row = `${sample.t_recv_ms},${sample.fps},${sample.dropped_frames},${sample.rtt_ms},${sample.t_server_rx_ns ?? ""}\n`;
    fs.appendFileSync(this.filePath, row, "utf8");
  }
}

module.exports = {
  NetRecorder
};
