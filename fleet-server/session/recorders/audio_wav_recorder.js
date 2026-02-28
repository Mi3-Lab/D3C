const fs = require("fs");

class AudioWavRecorder {
  constructor(filePath) {
    this.filePath = filePath;
    this.sampleRate = 48000;
    this.channels = 1;
    this.bitsPerSample = 16;
    this.dataBytes = 0;
    this.initialized = false;
  }

  ensureInit({ sampleRate, channels, bitsPerSample }) {
    if (this.initialized) return;
    this.sampleRate = Number(sampleRate) || this.sampleRate;
    this.channels = Number(channels) || this.channels;
    this.bitsPerSample = Number(bitsPerSample) || this.bitsPerSample;
    fs.writeFileSync(this.filePath, createWavHeader({
      dataBytes: 0,
      sampleRate: this.sampleRate,
      channels: this.channels,
      bitsPerSample: this.bitsPerSample
    }));
    this.initialized = true;
  }

  writeChunk({ pcmBuffer, sampleRate, channels, bitsPerSample }) {
    if (!pcmBuffer || !pcmBuffer.length) return;
    this.ensureInit({ sampleRate, channels, bitsPerSample });
    fs.appendFileSync(this.filePath, pcmBuffer);
    this.dataBytes += pcmBuffer.length;
  }

  finalize() {
    if (!this.initialized) return { ok: true, skipped: true };
    try {
      const fd = fs.openSync(this.filePath, "r+");
      const header = createWavHeader({
        dataBytes: this.dataBytes,
        sampleRate: this.sampleRate,
        channels: this.channels,
        bitsPerSample: this.bitsPerSample
      });
      fs.writeSync(fd, header, 0, header.length, 0);
      fs.closeSync(fd);
      return { ok: true, skipped: false, filePath: this.filePath, bytes: this.dataBytes };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
}

function createWavHeader({ dataBytes, sampleRate, channels, bitsPerSample }) {
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const buf = Buffer.alloc(44);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM format
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

module.exports = {
  AudioWavRecorder
};
