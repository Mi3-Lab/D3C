const fs = require("fs");

class GpsRecorder {
  constructor(filePath) {
    this.filePath = filePath;
    this.initialized = false;
  }

  ensureHeader() {
    if (this.initialized) return;
    fs.writeFileSync(
      this.filePath,
      "t_recv_ms,t_device_ms,lat,lon,accuracy_m,speed_mps,heading_deg,altitude_m\n",
      "utf8"
    );
    this.initialized = true;
  }

  write(sample) {
    this.ensureHeader();
    const row = [
      sample.t_recv_ms,
      sample.t_device_ms,
      sample.lat,
      sample.lon,
      sample.accuracy_m,
      sample.speed_mps,
      sample.heading_deg,
      sample.altitude_m
    ].join(",");
    fs.appendFileSync(this.filePath, `${row}\n`, "utf8");
  }
}

module.exports = {
  GpsRecorder
};
