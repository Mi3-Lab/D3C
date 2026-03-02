const fs = require("fs");

class ImuRecorder {
  constructor(filePath) {
    this.filePath = filePath;
    this.initialized = false;
  }

  ensureHeader() {
    if (this.initialized) return;
    fs.writeFileSync(
      this.filePath,
      "t_recv_ms,t_device_ms,ax,ay,az,gx,gy,gz,t_server_rx_ns\n",
      "utf8"
    );
    this.initialized = true;
  }

  write(sample) {
    this.ensureHeader();
    const row = [
      sample.t_recv_ms,
      sample.t_device_ms,
      sample.ax,
      sample.ay,
      sample.az,
      sample.gx,
      sample.gy,
      sample.gz,
      sample.t_server_rx_ns ?? ""
    ].join(",");
    fs.appendFileSync(this.filePath, `${row}\n`, "utf8");
  }
}

module.exports = {
  ImuRecorder
};
