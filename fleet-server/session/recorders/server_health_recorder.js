const fs = require("fs");

class ServerHealthRecorder {
  constructor(filePath) {
    this.filePath = filePath;
    this.initialized = false;
  }

  ensureHeader() {
    if (this.initialized) return;
    fs.writeFileSync(this.filePath, "t_server_ms,event_loop_lag_ms,heap_used_mb,heap_total_mb\n", "utf8");
    this.initialized = true;
  }

  write(sample) {
    this.ensureHeader();
    const row = `${sample.t_server_ms},${sample.event_loop_lag_ms},${sample.heap_used_mb},${sample.heap_total_mb}\n`;
    fs.appendFileSync(this.filePath, row, "utf8");
  }
}

module.exports = { ServerHealthRecorder };
