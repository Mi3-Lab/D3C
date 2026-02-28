const fs = require("fs");

class FusionRecorder {
  constructor(filePath) {
    this.filePath = filePath;
    this.initialized = false;
  }

  ensureHeader() {
    if (this.initialized) return;
    fs.writeFileSync(this.filePath, "t_recv_ms,connection_quality,sensing_confidence\n", "utf8");
    this.initialized = true;
  }

  write(sample) {
    this.ensureHeader();
    const row = `${sample.t_recv_ms},${sample.connection_quality},${sample.sensing_confidence}\n`;
    fs.appendFileSync(this.filePath, row, "utf8");
  }
}

module.exports = {
  FusionRecorder
};
