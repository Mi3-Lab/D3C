class SyncTracker {
  constructor(opts = {}) {
    this.windowMs = Math.max(10_000, Number(opts.windowMs || 120_000));
    this.minFitSamples = Math.max(4, Number(opts.minFitSamples || 8));
    this.lowRttFraction = Math.min(1, Math.max(0.2, Number(opts.lowRttFraction || 0.35)));

    this.pendingPings = new Map();
    this.pingSent = 0;
    this.pingAcked = 0;

    this.segments = [];
    this.currentSegment = null;
    this.startSegment(Date.now(), "initial");
  }

  startSegment(startServerMs = Date.now(), reason = "reconnect") {
    if (this.currentSegment && this.currentSegment.end_server_ms == null) {
      this.currentSegment.end_server_ms = Number(startServerMs);
    }
    const seg = {
      segment_id: this.segments.length + 1,
      reason,
      start_server_ms: Number(startServerMs),
      end_server_ms: null,
      ping_sent: 0,
      ping_acked: 0,
      samples: [],
      fit: null
    };
    this.segments.push(seg);
    this.currentSegment = seg;
  }

  recordPingSent(pingId, t1ServerSendMs) {
    const t1 = Number(t1ServerSendMs);
    if (!Number.isFinite(t1)) return;
    this.pendingPings.set(String(pingId), { t1 });
    this.pingSent += 1;
    if (this.currentSegment) this.currentSegment.ping_sent += 1;
  }

  recordPong(msg, t4ServerRecvMs = Date.now()) {
    const pingId = String(msg?.ping_id || "");
    const pending = this.pendingPings.get(pingId);
    this.pendingPings.delete(pingId);

    const t1 = pending?.t1 ?? Number(msg?.t1_server_send_ms);
    const t2 = Number(msg?.t2_device_recv_mono_ms);
    const t3 = Number(msg?.t3_device_send_mono_ms);
    const t4 = Number(t4ServerRecvMs);

    if (![t1, t2, t3, t4].every(Number.isFinite)) return null;

    let rtt = (t4 - t1) - (t3 - t2);
    if (!Number.isFinite(rtt) || rtt < 0) rtt = Math.max(0, t4 - t1);

    const x = (t2 + t3) * 0.5;
    const y = (t1 + t4) * 0.5;

    this.pingAcked += 1;
    if (this.currentSegment) this.currentSegment.ping_acked += 1;

    const seg = this.currentSegment;
    if (!seg) return null;
    seg.samples.push({ x_device_mono_ms: x, y_server_ms: y, rtt_ms: rtt, t4_server_ms: t4 });
    this._trimWindow(seg, t4);
    seg.fit = this._fitSegment(seg.samples);
    return { x, y, rtt };
  }

  mapDeviceMonoToServerMs(tDeviceMonoMs, serverHintMs = null) {
    const fit = this._bestFitForServerMs(serverHintMs);
    const x = Number(tDeviceMonoMs);
    if (!fit || !Number.isFinite(x)) return null;
    return fit.a_ms + fit.b * x;
  }

  getMapping(serverHintMs = null) {
    const fit = this._bestFitForServerMs(serverHintMs);
    if (!fit) return null;
    return {
      a_ms: fit.a_ms,
      b: fit.b,
      quality: {
        n: fit.n,
        rtt_mean: fit.rtt_mean,
        rtt_p95: fit.rtt_p95,
        residual_ms: fit.residual_ms,
        window_ms: fit.window_ms
      }
    };
  }

  getRttStats() {
    const fit = this._bestFitForServerMs();
    if (!fit) {
      return { mean_ms: null, p95_ms: null, min_ms: null, max_ms: null, samples: 0 };
    }
    return {
      mean_ms: fit.rtt_mean,
      p95_ms: fit.rtt_p95,
      min_ms: fit.rtt_min,
      max_ms: fit.rtt_max,
      samples: fit.n
    };
  }

  buildReport(nowMs = Date.now()) {
    const segments = this.segments.map((seg) => {
      const fit = seg.fit;
      const durationMs = Math.max(0, Number((seg.end_server_ms ?? nowMs) - seg.start_server_ms));
      const pingLossPct = seg.ping_sent > 0 ? ((seg.ping_sent - seg.ping_acked) / seg.ping_sent) * 100 : 0;
      return {
        segment_id: seg.segment_id,
        reason: seg.reason,
        start_server_ms: seg.start_server_ms,
        end_server_ms: seg.end_server_ms ?? nowMs,
        duration_ms: durationMs,
        ping_sent: seg.ping_sent,
        ping_acked: seg.ping_acked,
        ping_loss_pct: Number(pingLossPct.toFixed(3)),
        fit_window_ms: this.windowMs,
        fit: fit
          ? {
              a_ms: fit.a_ms,
              b: fit.b,
              n: fit.n,
              rtt_mean: fit.rtt_mean,
              rtt_p95: fit.rtt_p95,
              residual_ms: fit.residual_ms,
              window_ms: fit.window_ms
            }
          : null
      };
    });

    const overallLoss = this.pingSent > 0 ? ((this.pingSent - this.pingAcked) / this.pingSent) * 100 : 0;
    const best = this._bestFitForServerMs(nowMs);

    return {
      ping_sent: this.pingSent,
      ping_acked: this.pingAcked,
      ping_loss_pct: Number(overallLoss.toFixed(3)),
      mapping: best ? { a_ms: best.a_ms, b: best.b } : null,
      quality: best
        ? {
            n: best.n,
            rtt_mean: best.rtt_mean,
            rtt_p95: best.rtt_p95,
            residual_ms: best.residual_ms,
            window_ms: best.window_ms
          }
        : null,
      segments
    };
  }

  _trimWindow(seg, nowMs) {
    const minTs = Number(nowMs) - this.windowMs;
    if (!Array.isArray(seg.samples) || !seg.samples.length) return;
    let firstKeep = 0;
    while (firstKeep < seg.samples.length && seg.samples[firstKeep].t4_server_ms < minTs) firstKeep += 1;
    if (firstKeep > 0) seg.samples.splice(0, firstKeep);
  }

  _fitSegment(samples) {
    if (!Array.isArray(samples) || samples.length < this.minFitSamples) return null;
    const sorted = [...samples].sort((a, b) => a.rtt_ms - b.rtt_ms);
    const keepCount = Math.max(this.minFitSamples, Math.min(sorted.length, Math.ceil(sorted.length * this.lowRttFraction)));
    const kept = sorted.slice(0, keepCount);

    let sw = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;

    for (const s of kept) {
      const w = 1 / (s.rtt_ms * s.rtt_ms + 1e-6);
      sw += w;
      sx += w * s.x_device_mono_ms;
      sy += w * s.y_server_ms;
      sxx += w * s.x_device_mono_ms * s.x_device_mono_ms;
      sxy += w * s.x_device_mono_ms * s.y_server_ms;
    }

    const den = sw * sxx - sx * sx;
    if (!Number.isFinite(den) || Math.abs(den) < 1e-9) return null;

    const b = (sw * sxy - sx * sy) / den;
    const a = (sy - b * sx) / sw;

    // sort by time to get true temporal window of kept samples
    const keptByTime = [...kept].sort((p, q) => p.t4_server_ms - q.t4_server_ms);
    const tMin = keptByTime[0].t4_server_ms;
    const tMax = keptByTime[keptByTime.length - 1].t4_server_ms;
    const windowMs = Math.max(0, Number(tMax - tMin));

    // if samples don't span at least 30s, drift estimate is unreliable — fall back to 1.0
    const MIN_WINDOW_FOR_DRIFT_MS = 30_000;
    const bFinal = windowMs >= MIN_WINDOW_FOR_DRIFT_MS ? b : 1.0;
    const aFinal = windowMs >= MIN_WINDOW_FOR_DRIFT_MS ? a : (sy - 1.0 * sx) / sw;

    let wrss = 0;
    const rtts = [];
    for (const s of kept) {
      const w = 1 / (s.rtt_ms * s.rtt_ms + 1e-6);
      const err = s.y_server_ms - (aFinal + bFinal * s.x_device_mono_ms);
      wrss += w * err * err;
      rtts.push(s.rtt_ms);
    }
    rtts.sort((x, y) => x - y);
    const rttMean = rtts.reduce((acc, v) => acc + v, 0) / rtts.length;
    const p95Idx = Math.min(rtts.length - 1, Math.floor(0.95 * (rtts.length - 1)));
    const residual = Math.sqrt(Math.max(0, wrss / sw));

    return {
      a_ms: Number(aFinal.toFixed(6)),
      b: Number(bFinal.toFixed(12)),
      n: kept.length,
      rtt_mean: Number(rttMean.toFixed(3)),
      rtt_p95: Number(rtts[p95Idx].toFixed(3)),
      rtt_min: Number(rtts[0].toFixed(3)),
      rtt_max: Number(rtts[rtts.length - 1].toFixed(3)),
      residual_ms: Number(residual.toFixed(3)),
      window_ms: windowMs,
      drift_reliable: windowMs >= MIN_WINDOW_FOR_DRIFT_MS
    };
  }

  _bestFitForServerMs(serverMs = null) {
    const hint = Number(serverMs || Date.now());

    // Prefer matching segment by server time.
    for (const seg of this.segments) {
      if (!seg.fit) continue;
      const start = Number(seg.start_server_ms || 0);
      const end = Number(seg.end_server_ms == null ? Number.MAX_SAFE_INTEGER : seg.end_server_ms);
      if (hint >= start && hint <= end) return seg.fit;
    }

    // Fallback: latest segment with fit.
    for (let i = this.segments.length - 1; i >= 0; i -= 1) {
      if (this.segments[i].fit) return this.segments[i].fit;
    }
    return null;
  }
}

module.exports = {
  SyncTracker
};
