const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { encodeCameraDirToMp4 } = require("./recorders/camera_recorder");

const EXPORTS_DIRNAME = "exports";
const SESSION_MULTIVIEW_NAME = "session_multiview.mp4";
const SESSION_MULTIVIEW_WITH_AUDIO_NAME = "session_multiview_with_audio.mp4";
const SESSION_MULTIVIEW_MANIFEST_NAME = "session_multiview_manifest.json";
const CAMERA_WITH_AUDIO_NAME = "camera_with_audio.mp4";
const TILE_WIDTH = 640;
const TILE_HEIGHT = 360;

async function exportSessionMedia({ sessionDir, ffmpegBin = "ffmpeg", audioDeviceId = null, force = false } = {}) {
  const resolvedSessionDir = path.resolve(String(sessionDir || ""));
  if (!resolvedSessionDir || !fs.existsSync(resolvedSessionDir)) {
    return { ok: false, error: "session directory not found" };
  }

  const meta = readJson(path.join(resolvedSessionDir, "meta.json")) || {};
  const syncReport = readJson(path.join(resolvedSessionDir, "sync_report.json")) || {};
  const syncModels = loadSyncModels(syncReport);
  const deviceIds = listSessionDeviceIds(resolvedSessionDir, meta);
  const deviceInfos = deviceIds.map((deviceId) => loadDeviceInfo({
    sessionDir: resolvedSessionDir,
    deviceId,
    meta,
    syncReport,
    syncModels
  }));
  const exportsDir = path.join(resolvedSessionDir, EXPORTS_DIRNAME);
  fs.mkdirSync(exportsDir, { recursive: true });

  const result = {
    ok: true,
    had_errors: false,
    generated_at_iso: new Date().toISOString(),
    session_dir: resolvedSessionDir,
    exports_dir: exportsDir,
    audio_source_device_id: null,
    devices: {},
    exports: {},
    warnings: []
  };

  for (const info of deviceInfos) {
    result.devices[info.deviceId] = {
      device_id: info.deviceId,
      device_name: info.deviceName,
      camera_video: summarizeExistingFile(info.cameraVideoPath),
      camera_with_audio: null,
      audio_wav: summarizeExistingFile(info.audioWavPath),
      timeline: summarizeTimeline(info)
    };
  }

  for (const info of deviceInfos) {
    const deviceResult = result.devices[info.deviceId];
    const videoRes = await ensureDeviceVideo(info, ffmpegBin, { force });
    deviceResult.camera_video = videoRes;
    markExportError(result, videoRes);
  }

  for (const info of deviceInfos) {
    info.cameraVideoPath = fs.existsSync(info.cameraVideoPath) ? info.cameraVideoPath : null;
    if (!info.cameraVideoPath) continue;
    const deviceResult = result.devices[info.deviceId];
    const avRes = await createDeviceVideoWithAudio(info, ffmpegBin);
    deviceResult.camera_with_audio = avRes;
    markExportError(result, avRes);
  }

  const compositeInputs = deviceInfos.filter((info) => canIncludeInMultiview(info));
  const layout = buildLayout(compositeInputs.length);
  const globalWindow = computeGlobalWindow(compositeInputs);
  const sessionMultiviewPath = path.join(exportsDir, SESSION_MULTIVIEW_NAME);
  const sessionMultiviewWithAudioPath = path.join(exportsDir, SESSION_MULTIVIEW_WITH_AUDIO_NAME);
  const sessionManifestPath = path.join(exportsDir, SESSION_MULTIVIEW_MANIFEST_NAME);

  let multiviewRes = { ok: true, skipped: true, reason: "no_camera_inputs", path: sessionMultiviewPath };
  if (compositeInputs.length) {
    multiviewRes = await createMultiviewVideo({
      inputs: compositeInputs,
      outPath: sessionMultiviewPath,
      ffmpegBin,
      layout,
      globalWindow
    });
    markExportError(result, multiviewRes);
  }
  result.exports.session_multiview = multiviewRes;

  const chosenAudioInfo = chooseAudioSource(deviceInfos, meta, audioDeviceId);
  result.audio_source_device_id = chosenAudioInfo?.deviceId || null;
  let multiviewAudioRes = {
    ok: true,
    skipped: true,
    reason: chosenAudioInfo ? "missing_multiview_video" : "no_audio_source",
    path: sessionMultiviewWithAudioPath
  };
  if (multiviewRes.ok && !multiviewRes.skipped && chosenAudioInfo) {
    const sessionAudio = buildSessionAudioSpec(chosenAudioInfo, globalWindow);
    if (!sessionAudio.ok) {
      multiviewAudioRes = { ok: false, path: sessionMultiviewWithAudioPath, error: sessionAudio.error };
    } else {
      multiviewAudioRes = await muxVideoWithAudio({
        videoPath: sessionMultiviewPath,
        audioPath: chosenAudioInfo.audioWavPath,
        outPath: sessionMultiviewWithAudioPath,
        ffmpegBin,
        offsetSec: sessionAudio.offsetSec,
        audioTempoFactor: sessionAudio.audioTempoFactor
      });
    }
    markExportError(result, multiviewAudioRes);
  }
  result.exports.session_multiview_with_audio = multiviewAudioRes;

  result.exports.session_multiview_manifest = {
    ok: true,
    skipped: false,
    path: sessionManifestPath
  };
  const manifest = buildSessionManifest({
    meta,
    syncReport,
    deviceInfos,
    result,
    layout,
    globalWindow
  });
  fs.writeFileSync(sessionManifestPath, JSON.stringify(manifest, null, 2), "utf8");

  return result;
}

function ensurePositiveNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function summarizeExistingFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { ok: true, skipped: true, reason: "missing", path: filePath || null };
  return { ok: true, skipped: false, path: filePath };
}

function summarizeTimeline(info) {
  const camera = info.cameraTimeline;
  const audio = info.audioTimeline;
  return {
    camera: camera ? {
      source: camera.timelineSource,
      start_ms: roundNumber(camera.absoluteStartMs),
      duration_ms: roundNumber(camera.durationMs),
      server_scale: roundNumber(camera.serverScale)
    } : null,
    audio: audio ? {
      source: audio.source,
      start_ms: roundNumber(audio.absoluteStartMs),
      duration_ms: roundNumber(audio.durationMs)
    } : null
  };
}

async function ensureDeviceVideo(info, ffmpegBin, { force = false } = {}) {
  if (!force && info.cameraVideoPath && fs.existsSync(info.cameraVideoPath)) {
    return { ok: true, skipped: false, path: info.cameraVideoPath, existing: true };
  }
  if (!info.cameraDir || !fs.existsSync(info.cameraDir)) {
    return { ok: true, skipped: true, reason: "camera_frames_missing", path: info.cameraVideoPath };
  }
  if (!info.cameraTimestampsPath || !fs.existsSync(info.cameraTimestampsPath)) {
    return { ok: true, skipped: true, reason: "camera_timestamps_missing", path: info.cameraVideoPath };
  }

  const result = await encodeCameraDirToMp4({
    cameraDir: info.cameraDir,
    timestampsPath: info.cameraTimestampsPath,
    outMp4: info.cameraVideoPath,
    fps: info.videoFps,
    bitrate: info.videoBitrate,
    crf: info.videoCrf,
    ffmpegBin,
    timelineRows: info.cameraTimeline?.rows || null
  });
  return { ...result, path: info.cameraVideoPath };
}

async function createDeviceVideoWithAudio(info, ffmpegBin) {
  const outPath = path.join(info.streamsDir, CAMERA_WITH_AUDIO_NAME);
  if (!info.cameraVideoPath || !fs.existsSync(info.cameraVideoPath)) {
    return { ok: true, skipped: true, reason: "camera_video_missing", path: outPath };
  }
  if (!info.audioWavPath || !fs.existsSync(info.audioWavPath)) {
    return { ok: true, skipped: true, reason: "audio_wav_missing", path: outPath };
  }
  if (!info.audioTimeline || !info.cameraTimeline) {
    return { ok: true, skipped: true, reason: "timing_metadata_missing", path: outPath };
  }

  const deviceAudio = buildDeviceAudioSpec(info);
  if (!deviceAudio.ok) {
    return { ok: false, path: outPath, error: deviceAudio.error };
  }

  return muxVideoWithAudio({
    videoPath: info.cameraVideoPath,
    audioPath: info.audioWavPath,
    outPath,
    ffmpegBin,
    offsetSec: deviceAudio.offsetSec,
    audioTempoFactor: 1
  });
}

function buildDeviceAudioSpec(info) {
  if (info.cameraTimeline?.timelineSource === "t_aligned_utc_ms") {
    if (!Number.isFinite(info.cameraTimeline.absoluteStartMs) || !Number.isFinite(info.audioTimeline?.absoluteStartMs)) {
      return { ok: false, error: "absolute camera/audio timing unavailable" };
    }
    return {
      ok: true,
      offsetSec: (info.audioTimeline.absoluteStartMs - info.cameraTimeline.absoluteStartMs) / 1000
    };
  }

  const cameraStartMs = pickLocalCameraStartMs(info.cameraTimeline);
  if (!Number.isFinite(cameraStartMs)) {
    return { ok: false, error: "camera local start unavailable" };
  }
  const audioStartMs = pickLocalAudioStartMs(info.audioTimeline, info.cameraTimeline?.timelineSource);
  if (!Number.isFinite(audioStartMs)) {
    return { ok: false, error: "audio local start unavailable" };
  }
  return {
    ok: true,
    offsetSec: (audioStartMs - cameraStartMs) / 1000
  };
}

function buildSessionAudioSpec(info, globalWindow) {
  if (!globalWindow || !Number.isFinite(globalWindow.startMs)) {
    return { ok: false, error: "global video window unavailable" };
  }
  if (!info.audioTimeline || !Number.isFinite(info.audioTimeline.absoluteStartMs)) {
    return { ok: false, error: "audio absolute start unavailable" };
  }
  return {
    ok: true,
    offsetSec: (info.audioTimeline.absoluteStartMs - globalWindow.startMs) / 1000,
    audioTempoFactor: 1 / Math.max(0.0001, Number(info.audioTimeline.serverScale || 1))
  };
}

function canIncludeInMultiview(info) {
  return !!(info.cameraVideoPath && fs.existsSync(info.cameraVideoPath) && info.cameraTimeline && Number.isFinite(info.cameraTimeline.absoluteStartMs));
}

function buildLayout(count) {
  const safeCount = Math.max(0, Number(count || 0));
  if (!safeCount) {
    return {
      count: 0,
      cols: 0,
      rows: 0,
      tile_width: TILE_WIDTH,
      tile_height: TILE_HEIGHT,
      canvas_width: 0,
      canvas_height: 0
    };
  }
  const cols = safeCount === 2 ? 2 : Math.ceil(Math.sqrt(safeCount));
  const rows = Math.ceil(safeCount / cols);
  return {
    count: safeCount,
    cols,
    rows,
    tile_width: TILE_WIDTH,
    tile_height: TILE_HEIGHT,
    canvas_width: cols * TILE_WIDTH,
    canvas_height: rows * TILE_HEIGHT
  };
}

function computeGlobalWindow(inputs) {
  if (!Array.isArray(inputs) || !inputs.length) return null;
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;
  for (const info of inputs) {
    if (!info.cameraTimeline) continue;
    startMs = Math.min(startMs, info.cameraTimeline.absoluteStartMs);
    endMs = Math.max(endMs, info.cameraTimeline.absoluteStartMs + info.cameraTimeline.durationMs);
  }
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return { startMs, endMs, durationMs: endMs - startMs };
}

async function createMultiviewVideo({ inputs, outPath, ffmpegBin, layout, globalWindow }) {
  if (!inputs.length) {
    return { ok: true, skipped: true, reason: "no_inputs", path: outPath };
  }
  if (!globalWindow) {
    return { ok: false, path: outPath, error: "global timeline unavailable" };
  }
  if (inputs.length === 1) {
    const info = inputs[0];
    const offsetSec = Math.max(0, (info.cameraTimeline.absoluteStartMs - globalWindow.startMs) / 1000);
    const serverScale = Math.max(0.0001, Number(info.cameraTimeline.serverScale || 1));
    const args = [
      "-y",
      "-i", info.cameraVideoPath,
      "-filter:v",
      `setpts=${formatFfmpegNumber(serverScale)}*(PTS-STARTPTS)+${formatFfmpegNumber(offsetSec)}/TB,` +
      `scale=${TILE_WIDTH}:${TILE_HEIGHT}:force_original_aspect_ratio=decrease,` +
      `pad=${TILE_WIDTH}:${TILE_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black`,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      outPath
    ];
    const res = await runFfmpeg(args, ffmpegBin);
    return { ...res, path: outPath };
  }

  const args = ["-y"];
  const filterParts = [];
  const stackedLabels = [];
  const positionSpecs = [];

  inputs.forEach((info, idx) => {
    args.push("-i", info.cameraVideoPath);
    const offsetSec = Math.max(0, (info.cameraTimeline.absoluteStartMs - globalWindow.startMs) / 1000);
    const serverScale = Math.max(0.0001, Number(info.cameraTimeline.serverScale || 1));
    const tileX = (idx % layout.cols) * layout.tile_width;
    const tileY = Math.floor(idx / layout.cols) * layout.tile_height;
    const label = `v${idx}`;
    positionSpecs.push(`${tileX}_${tileY}`);
    stackedLabels.push(`[${label}]`);
    filterParts.push(
      `[${idx}:v]setpts=${formatFfmpegNumber(serverScale)}*(PTS-STARTPTS)+${formatFfmpegNumber(offsetSec)}/TB,` +
      `scale=${layout.tile_width}:${layout.tile_height}:force_original_aspect_ratio=decrease,` +
      `pad=${layout.tile_width}:${layout.tile_height}:(ow-iw)/2:(oh-ih)/2:black[${label}]`
    );
  });

  filterParts.push(
    `${stackedLabels.join("")}xstack=inputs=${inputs.length}:layout=${positionSpecs.join("|")}:fill=black:shortest=0[outv]`
  );

  args.push(
    "-filter_complex", filterParts.join(";"),
    "-map", "[outv]",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    outPath
  );

  const res = await runFfmpeg(args, ffmpegBin);
  return { ...res, path: outPath };
}

async function muxVideoWithAudio({ videoPath, audioPath, outPath, ffmpegBin, offsetSec = 0, audioTempoFactor = 1 }) {
  const args = ["-y", "-i", videoPath, "-i", audioPath];
  const audioFilters = [];
  const clampedTempo = Number.isFinite(audioTempoFactor) && audioTempoFactor > 0 ? audioTempoFactor : 1;
  audioFilters.push(...buildAtempoFilters(clampedTempo));
  if (offsetSec < -0.0005) {
    audioFilters.push(`atrim=start=${formatFfmpegNumber(Math.abs(offsetSec))}`, "asetpts=PTS-STARTPTS");
  } else if (offsetSec > 0.0005) {
    const delayMs = Math.round(offsetSec * 1000);
    audioFilters.push(`adelay=${delayMs}:all=1`);
  }

  if (audioFilters.length) {
    args.push(
      "-filter_complex",
      `[1:a]${audioFilters.join(",")}[outa]`,
      "-map", "0:v",
      "-map", "[outa]"
    );
  } else {
    args.push("-map", "0:v", "-map", "1:a");
  }

  args.push(
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    outPath
  );
  const res = await runFfmpeg(args, ffmpegBin);
  return { ...res, path: outPath };
}

function buildAtempoFilters(factor) {
  const out = [];
  let remaining = Number(factor);
  if (!Number.isFinite(remaining) || remaining <= 0) return out;
  while (remaining < 0.5) {
    out.push("atempo=0.5");
    remaining /= 0.5;
  }
  while (remaining > 2.0) {
    out.push("atempo=2.0");
    remaining /= 2.0;
  }
  if (Math.abs(remaining - 1) > 0.0005) {
    out.push(`atempo=${formatFfmpegNumber(remaining)}`);
  }
  return out;
}

function runFfmpeg(args, ffmpegBin) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegBin, args, { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (buf) => {
      stderr += buf.toString();
    });
    proc.on("error", (err) => {
      resolve({ ok: false, error: String(err?.message || err) });
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: `ffmpeg exit ${code}: ${stderr.slice(-500)}` });
        return;
      }
      resolve({ ok: true, skipped: false });
    });
  });
}

function chooseAudioSource(deviceInfos, meta, requestedAudioDeviceId) {
  const preferredIds = [];
  if (requestedAudioDeviceId) preferredIds.push(requestedAudioDeviceId);
  if (meta?.focused_device_id) preferredIds.push(meta.focused_device_id);
  if (Array.isArray(meta?.target_device_ids)) preferredIds.push(...meta.target_device_ids);

  for (const id of preferredIds) {
    const match = deviceInfos.find((info) => info.deviceId === id && hasUsableAudio(info));
    if (match) return match;
  }
  return deviceInfos.find(hasUsableAudio) || null;
}

function hasUsableAudio(info) {
  return !!(info?.audioWavPath && fs.existsSync(info.audioWavPath) && info.audioTimeline);
}

function buildSessionManifest({ meta, syncReport, deviceInfos, result, layout, globalWindow }) {
  return {
    generated_at_iso: result.generated_at_iso,
    session_dir: result.session_dir,
    session_name: meta?.session_name || null,
    focused_device_id: meta?.focused_device_id || null,
    audio_source_device_id: result.audio_source_device_id || null,
    layout: layout || null,
    global_timeline: globalWindow ? {
      start_ms: roundNumber(globalWindow.startMs),
      end_ms: roundNumber(globalWindow.endMs),
      duration_ms: roundNumber(globalWindow.durationMs)
    } : null,
    exports: {
      session_multiview: relativize(result.session_dir, result.exports.session_multiview?.path || null),
      session_multiview_with_audio: relativize(result.session_dir, result.exports.session_multiview_with_audio?.path || null),
      session_multiview_manifest: relativize(result.session_dir, result.exports.session_multiview_manifest?.path || null)
    },
    devices: deviceInfos.map((info) => ({
      device_id: info.deviceId,
      device_name: info.deviceName,
      video_fps: info.videoFps,
      included_in_multiview: canIncludeInMultiview(info),
      camera_video: relativize(result.session_dir, info.cameraVideoPath),
      camera_with_audio: relativize(result.session_dir, path.join(info.streamsDir, CAMERA_WITH_AUDIO_NAME)),
      audio_wav: relativize(result.session_dir, info.audioWavPath),
      audio_chunks_csv: relativize(result.session_dir, info.audioChunksPath),
      timeline: summarizeTimeline(info)
    })),
    sync_report_generated_at_iso: syncReport?.generated_at_iso || null,
    had_errors: !!result.had_errors,
    warnings: result.warnings || []
  };
}

function loadDeviceInfo({ sessionDir, deviceId, meta, syncReport, syncModels }) {
  const streamsDir = path.join(sessionDir, "devices", sanitizeDeviceId(deviceId), "streams");
  const cameraTimestampsPath = path.join(streamsDir, "camera_timestamps.csv");
  const cameraDir = path.join(streamsDir, "camera");
  const cameraVideoPath = path.join(streamsDir, "camera_video.mp4");
  const audioWavPath = path.join(streamsDir, "audio.wav");
  const audioCsvPath = path.join(streamsDir, "audio.csv");
  const audioChunksPath = path.join(streamsDir, "audio_chunks.csv");
  const runConfig = meta?.devices?.[deviceId]?.runConfig || {};
  const deviceReport = syncReport?.devices?.[deviceId] || {};
  const cameraTimeline = loadCameraTimeline(cameraTimestampsPath, deviceId, syncModels);
  const audioTimeline = loadAudioTimeline({
    audioChunksPath,
    audioCsvPath,
    audioWavPath,
    deviceId,
    syncModels
  });

  return {
    deviceId,
    deviceName: deviceReport.device_name || deviceId,
    streamsDir,
    cameraDir,
    cameraTimestampsPath,
    cameraVideoPath,
    audioWavPath,
    audioCsvPath,
    audioChunksPath,
    videoFps: ensurePositiveNumber(runConfig?.streams?.camera?.video_fps, ensurePositiveNumber(runConfig?.streams?.camera?.fps, 10)),
    videoBitrate: String(runConfig?.streams?.camera?.video_bitrate || "2M"),
    videoCrf: ensurePositiveNumber(runConfig?.streams?.camera?.video_crf, 23),
    cameraTimeline,
    audioTimeline
  };
}

function loadCameraTimeline(timestampsPath, deviceId, syncModels) {
  if (!timestampsPath || !fs.existsSync(timestampsPath)) return null;
  const rawRows = readCsvLines(timestampsPath).slice(1).map(parseCameraTimestampRow).filter(Boolean);
  const rows = buildAlignedCameraRows(rawRows, deviceId, syncModels);
  if (rows.length < 2) return null;
  const chosen = chooseTimeline(rows);
  if (!chosen) return null;
  const firstRow = chosen.rows[0];
  const absoluteStartMs = resolveCameraAbsoluteStartMs(firstRow, deviceId, syncModels, chosen.source);
  if (!Number.isFinite(absoluteStartMs)) return null;
  const serverScale = resolveCameraServerScale(deviceId, syncModels, chosen.source);
  const durationMs = Math.max(0, chosen.values[chosen.values.length - 1] - chosen.values[0]) * serverScale;
  return {
    timelineSource: chosen.source,
    firstRow,
    rows: chosen.rows,
    absoluteStartMs,
    durationMs,
    serverScale
  };
}

function buildAlignedCameraRows(rows, deviceId, syncModels) {
  return rows.map((row) => {
    const serverMs = Number.isFinite(row.tServerRxNs)
      ? row.tServerRxNs / 1_000_000
      : (Number.isFinite(row.tRecvMs) ? row.tRecvMs : null);
    const syncedMs = alignUtcMs(syncModels, deviceId, row.tDeviceMs, row.tServerRxNs);
    const useSynced = Number.isFinite(syncedMs) &&
      Number.isFinite(serverMs) &&
      Math.abs(syncedMs - serverMs) <= 3000;
    const timelineMs = useSynced
      ? syncedMs
      : (Number.isFinite(serverMs) ? serverMs : null);
    return {
      ...row,
      timelineMs,
      timelineSource: useSynced ? "sync_model" : "server_receive_fallback"
    };
  }).filter((row) => Number.isFinite(row.timelineMs));
}

function loadAudioTimeline({ audioChunksPath, audioCsvPath, audioWavPath, deviceId, syncModels }) {
  const wavDurationMs = readWavDurationMs(audioWavPath);
  const chunkRows = readCsvLines(audioChunksPath).slice(1).map(parseAudioChunkRow).filter(Boolean);
  if (chunkRows.length) {
    const first = chunkRows[0];
    const durationMs = Number.isFinite(wavDurationMs) ? wavDurationMs : null;
    const source = Number.isFinite(first.tDeviceMs) ? "t_device_ms" : (Number.isFinite(first.tServerRxNs) ? "t_server_rx_ns" : "t_recv_ms");
    const serverScale = source === "t_device_ms"
      ? resolveGlobalServerScale(deviceId, syncModels)
      : 1;
    let absoluteStartMs = null;
    if (source === "t_device_ms") {
      const chunkStartDeviceMs = first.tDeviceMs - first.durationMs;
      absoluteStartMs = alignUtcMs(syncModels, deviceId, chunkStartDeviceMs, first.tServerRxNs);
    }
    if (!Number.isFinite(absoluteStartMs) && Number.isFinite(first.tServerRxNs)) {
      absoluteStartMs = (first.tServerRxNs / 1_000_000) - first.durationMs;
    }
    if (!Number.isFinite(absoluteStartMs) && Number.isFinite(first.tRecvMs)) {
      absoluteStartMs = first.tRecvMs - first.durationMs;
    }
    return {
      source,
      firstChunk: first,
      absoluteStartMs,
      durationMs,
      serverScale,
      localStartDeviceMs: Number.isFinite(first.tDeviceMs) ? first.tDeviceMs - first.durationMs : null,
      localStartRecvMs: Number.isFinite(first.tRecvMs) ? first.tRecvMs - first.durationMs : null,
      localStartServerMs: Number.isFinite(first.tServerRxNs) ? (first.tServerRxNs / 1_000_000) - first.durationMs : null
    };
  }

  const rows = readCsvLines(audioCsvPath).slice(1).map(parseAudioCsvRow).filter(Boolean);
  if (!rows.length) return null;
  const first = rows[0];
  const source = Number.isFinite(first.tDeviceMs) ? "t_device_ms" : (Number.isFinite(first.tServerRxNs) ? "t_server_rx_ns" : "t_recv_ms");
  const serverScale = source === "t_device_ms"
    ? resolveGlobalServerScale(deviceId, syncModels)
    : 1;
  let absoluteStartMs = null;
  if (source === "t_device_ms") {
    absoluteStartMs = alignUtcMs(syncModels, deviceId, first.tDeviceMs, first.tServerRxNs);
  }
  if (!Number.isFinite(absoluteStartMs) && Number.isFinite(first.tServerRxNs)) {
    absoluteStartMs = first.tServerRxNs / 1_000_000;
  }
  if (!Number.isFinite(absoluteStartMs) && Number.isFinite(first.tRecvMs)) {
    absoluteStartMs = first.tRecvMs;
  }
  return {
    source,
    firstChunk: null,
    absoluteStartMs,
    durationMs: Number.isFinite(wavDurationMs) ? wavDurationMs : null,
    serverScale,
    localStartDeviceMs: Number.isFinite(first.tDeviceMs) ? first.tDeviceMs : null,
    localStartRecvMs: Number.isFinite(first.tRecvMs) ? first.tRecvMs : null,
    localStartServerMs: Number.isFinite(first.tServerRxNs) ? first.tServerRxNs / 1_000_000 : null
  };
}

function pickLocalCameraStartMs(cameraTimeline) {
  if (!cameraTimeline?.firstRow) return null;
  if (cameraTimeline.timelineSource === "t_device_ms" && Number.isFinite(cameraTimeline.firstRow.tDeviceMs)) {
    return cameraTimeline.firstRow.tDeviceMs;
  }
  if (cameraTimeline.timelineSource === "t_server_rx_ns" && Number.isFinite(cameraTimeline.firstRow.tServerRxNs)) {
    return cameraTimeline.firstRow.tServerRxNs / 1_000_000;
  }
  if (Number.isFinite(cameraTimeline.firstRow.tRecvMs)) return cameraTimeline.firstRow.tRecvMs;
  return null;
}

function pickLocalAudioStartMs(audioTimeline, preferredSource) {
  if (!audioTimeline) return null;
  if (preferredSource === "t_device_ms" && Number.isFinite(audioTimeline.localStartDeviceMs)) return audioTimeline.localStartDeviceMs;
  if (preferredSource === "t_server_rx_ns" && Number.isFinite(audioTimeline.localStartServerMs)) return audioTimeline.localStartServerMs;
  if (preferredSource === "t_recv_ms" && Number.isFinite(audioTimeline.localStartRecvMs)) return audioTimeline.localStartRecvMs;
  if (Number.isFinite(audioTimeline.localStartDeviceMs)) return audioTimeline.localStartDeviceMs;
  if (Number.isFinite(audioTimeline.localStartServerMs)) return audioTimeline.localStartServerMs;
  if (Number.isFinite(audioTimeline.localStartRecvMs)) return audioTimeline.localStartRecvMs;
  return null;
}

function resolveCameraAbsoluteStartMs(firstRow, deviceId, syncModels, source) {
  if (!firstRow) return null;
  if (source === "t_aligned_utc_ms" && Number.isFinite(firstRow.timelineMs)) return firstRow.timelineMs;
  if (source === "t_device_ms") {
    const aligned = alignUtcMs(syncModels, deviceId, firstRow.tDeviceMs, firstRow.tServerRxNs);
    if (Number.isFinite(aligned)) return aligned;
  }
  if (source === "t_server_rx_ns" && Number.isFinite(firstRow.tServerRxNs)) return firstRow.tServerRxNs / 1_000_000;
  if (Number.isFinite(firstRow.tRecvMs)) return firstRow.tRecvMs;
  if (Number.isFinite(firstRow.tServerRxNs)) return firstRow.tServerRxNs / 1_000_000;
  return null;
}

function resolveCameraServerScale(deviceId, syncModels, source) {
  if (source !== "t_device_ms") return 1;
  return resolveGlobalServerScale(deviceId, syncModels);
}

function resolveGlobalServerScale(deviceId, syncModels) {
  const model = syncModels?.[deviceId];
  const b = Number(model?.global?.b);
  return Number.isFinite(b) && b > 0 ? b : 1;
}

function listSessionDeviceIds(sessionDir, meta) {
  if (Array.isArray(meta?.target_device_ids) && meta.target_device_ids.length) {
    return meta.target_device_ids.map((id) => String(id));
  }
  const devicesRoot = path.join(sessionDir, "devices");
  if (!fs.existsSync(devicesRoot)) return [];
  return fs.readdirSync(devicesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function loadSyncModels(syncReport) {
  const devices = syncReport?.devices;
  if (!devices || typeof devices !== "object") return {};
  const models = {};
  for (const [deviceId, info] of Object.entries(devices)) {
    const sync = info?.sync;
    if (!sync || typeof sync !== "object") continue;
    const mapping = sync.mapping;
    const globalFit = mapping && Number.isFinite(Number(mapping.a_ms)) && Number.isFinite(Number(mapping.b))
      ? { a_ms: Number(mapping.a_ms), b: Number(mapping.b) }
      : null;
    const segments = Array.isArray(sync.segments)
      ? sync.segments.map((segment) => {
          const fit = segment?.fit;
          if (!fit || !Number.isFinite(Number(fit.a_ms)) || !Number.isFinite(Number(fit.b))) return null;
          return {
            start_ms: Number(segment.start_server_ms || 0),
            end_ms: Number(segment.end_server_ms || 0),
            a_ms: Number(fit.a_ms),
            b: Number(fit.b)
          };
        }).filter(Boolean)
      : [];
    models[deviceId] = { global: globalFit, segments };
  }
  return models;
}

function alignUtcMs(syncModels, deviceId, tDeviceMs, tServerRxNs) {
  if (!Number.isFinite(Number(tDeviceMs))) return null;
  const fit = pickSyncFit(syncModels?.[deviceId], tServerRxNs);
  if (!fit) return null;
  return Number(fit.a_ms) + Number(fit.b) * Number(tDeviceMs);
}

function pickSyncFit(model, tServerRxNs) {
  if (!model) return null;
  const serverMs = Number.isFinite(Number(tServerRxNs)) ? Number(tServerRxNs) / 1_000_000 : null;
  if (Number.isFinite(serverMs)) {
    for (const segment of model.segments || []) {
      if (serverMs >= segment.start_ms && serverMs <= segment.end_ms) return segment;
    }
  }
  return model.global || null;
}

function readWavDurationMs(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const fd = fs.openSync(filePath, "r");
    const header = Buffer.alloc(44);
    fs.readSync(fd, header, 0, header.length, 0);
    fs.closeSync(fd);
    if (header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") return null;
    const byteRate = header.readUInt32LE(28);
    const dataBytes = header.readUInt32LE(40);
    if (!byteRate) return null;
    return (dataBytes / byteRate) * 1000;
  } catch {
    return null;
  }
}

function readCsvLines(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) return [];
  return raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

function parseCameraTimestampRow(line) {
  const parts = line.split(",");
  if (parts.length < 4) return null;
  const filename = parts[1];
  if (!filename) return null;
  return {
    filename,
    tDeviceMs: toFiniteNumber(parts[2]),
    tRecvMs: toFiniteNumber(parts[3]),
    tServerRxNs: toFiniteNumber(parts[4])
  };
}

function parseAudioCsvRow(line) {
  const parts = line.split(",");
  if (parts.length < 4) return null;
  return {
    tRecvMs: toFiniteNumber(parts[0]),
    tDeviceMs: toFiniteNumber(parts[1]),
    tServerRxNs: toFiniteNumber(parts[4])
  };
}

function parseAudioChunkRow(line) {
  const parts = line.split(",");
  if (parts.length < 9) return null;
  return {
    chunkIndex: toFiniteNumber(parts[0]),
    tRecvMs: toFiniteNumber(parts[1]),
    tDeviceMs: toFiniteNumber(parts[2]),
    tServerRxNs: toFiniteNumber(parts[3]),
    sampleRate: toFiniteNumber(parts[4]),
    channels: toFiniteNumber(parts[5]),
    bitsPerSample: toFiniteNumber(parts[6]),
    samples: toFiniteNumber(parts[7]),
    durationMs: toFiniteNumber(parts[8])
  };
}

function chooseTimeline(rows) {
  const candidates = [
    buildMonotonicTimeline(rows, "t_aligned_utc_ms", (row) => row.timelineMs),
    buildMonotonicTimeline(rows, "t_device_ms", (row) => row.tDeviceMs),
    buildMonotonicTimeline(rows, "t_server_rx_ns", (row) => row.tServerRxNs, { scale: 1 / 1_000_000 }),
    buildMonotonicTimeline(rows, "t_recv_ms", (row) => row.tRecvMs)
  ].filter(Boolean);

  if (!candidates.length) return null;
  const maxLength = Math.max(...candidates.map((candidate) => candidate.values.length));
  const aligned = candidates.find((candidate) => candidate.source === "t_aligned_utc_ms");
  if (aligned && aligned.values.length >= maxLength * 0.9) return aligned;
  candidates.sort((a, b) => {
    if (b.values.length !== a.values.length) return b.values.length - a.values.length;
    const priority = { t_aligned_utc_ms: 4, t_device_ms: 3, t_server_rx_ns: 2, t_recv_ms: 1 };
    return (priority[b.source] || 0) - (priority[a.source] || 0);
  });
  return candidates[0];
}

function isStrictlyIncreasing(values) {
  if (!Array.isArray(values) || values.length < 2) return false;
  for (let i = 0; i < values.length; i += 1) {
    if (!Number.isFinite(values[i])) return false;
    if (i > 0 && values[i] <= values[i - 1]) return false;
  }
  return true;
}

function buildMonotonicTimeline(rows, source, getter, options = {}) {
  const scale = Number.isFinite(options.scale) ? options.scale : 1;
  const keptRows = [];
  const values = [];
  let lastValue = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const rawValue = getter(row);
    if (!Number.isFinite(rawValue)) continue;
    const value = rawValue * scale;
    if (!(value > lastValue)) continue;
    keptRows.push(row);
    values.push(value);
    lastValue = value;
  }
  if (values.length < 2) return null;
  return { source, rows: keptRows, values };
}

function sanitizeDeviceId(deviceId) {
  return String(deviceId || "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
}

function relativize(root, absPath) {
  if (!absPath) return null;
  try {
    return path.relative(root, absPath) || ".";
  } catch {
    return absPath;
  }
}

function markExportError(result, subResult) {
  if (!subResult || subResult.ok !== false) return;
  result.had_errors = true;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function roundNumber(value) {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : null;
}

function formatFfmpegNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return Number(n.toFixed(6)).toString();
}

module.exports = {
  exportSessionMedia,
  EXPORTS_DIRNAME,
  SESSION_MULTIVIEW_NAME,
  SESSION_MULTIVIEW_WITH_AUDIO_NAME,
  SESSION_MULTIVIEW_MANIFEST_NAME,
  CAMERA_WITH_AUDIO_NAME
};
