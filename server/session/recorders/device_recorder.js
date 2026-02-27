const fs = require("fs");

class DeviceRecorder {
  constructor(filePath) {
    this.filePath = filePath;
    this.initialized = false;
  }

  ensureHeader() {
    if (this.initialized) return;
    fs.writeFileSync(this.filePath, "t_recv_ms,t_device_ms,battery_level,charging,orientation\n", "utf8");
    this.initialized = true;
  }

  write(sample) {
    this.ensureHeader();
    const row = `${sample.t_recv_ms},${sample.t_device_ms},${sample.battery_level},${sample.charging},${sample.orientation}\n`;
    fs.appendFileSync(this.filePath, row, "utf8");
  }
}

module.exports = {
  DeviceRecorder
};
