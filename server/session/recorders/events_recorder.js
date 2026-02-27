const fs = require("fs");

class EventsRecorder {
  constructor(filePath) {
    this.filePath = filePath;
    this.initialized = false;
  }

  ensureHeader() {
    if (this.initialized) return;
    fs.writeFileSync(this.filePath, "t_recv_ms,t_device_ms,label,meta_json\n", "utf8");
    this.initialized = true;
  }

  write(evt) {
    this.ensureHeader();
    const meta = JSON.stringify(evt.meta || {}).replaceAll('"', '""');
    const label = String(evt.label || "").replaceAll('"', '""');
    const row = `${evt.t_recv_ms},${evt.t_device_ms},"${label}","${meta}"\n`;
    fs.appendFileSync(this.filePath, row, "utf8");
  }
}

module.exports = {
  EventsRecorder
};
