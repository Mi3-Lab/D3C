class MotionState {
  constructor(windowSize = 60) {
    this.windowSize = windowSize;
    this.buffer = [];
    this.state = "UNKNOWN";
  }

  update(ax, ay, az) {
    const mag = Math.sqrt(ax * ax + ay * ay + az * az);
    this.buffer.push(mag);
    if (this.buffer.length > this.windowSize) this.buffer.shift();
    if (this.buffer.length < 10) return { motion_state: this.state, variance: 0, confidence: 0 };

    const mean = this.buffer.reduce((a, b) => a + b, 0) / this.buffer.length;
    const variance =
      this.buffer.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / this.buffer.length;

    if (variance < 0.05) this.state = "STILL";
    else if (variance < 0.5) this.state = "MOVING";
    else this.state = "HIGH";

    const confidence = Math.max(0, Math.min(1, variance / 0.5));
    return { motion_state: this.state, variance, confidence };
  }
}

module.exports = {
  MotionState
};
