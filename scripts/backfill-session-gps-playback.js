#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const {
  EXPORTS_DIRNAME,
  SESSION_MULTIVIEW_MANIFEST_NAME,
  SESSION_MULTIVIEW_WITH_AUDIO_NAME,
  SESSION_MULTIVIEW_WITH_AUDIO_AND_GPS_NAME,
  SESSION_GPS_PLAYBACK_NAME,
  SESSION_GPS_PLAYBACK_VIDEO_NAME,
  exportSessionGpsPlaybackForSession,
  renderGpsPlaybackVideo,
  composeMultiviewWithAudioAndGps
} = require("../fleet-server/session/export_session_media");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DATASETS_ROOT = process.env.DATASETS_ROOT
  ? path.resolve(process.env.DATASETS_ROOT)
  : path.join(PROJECT_ROOT, "datasets");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return 0;
  }

  const sessions = resolveSessions(args);
  if (!sessions.length) {
    console.log(`No matching sessions found under ${DATASETS_ROOT}`);
    return 0;
  }

  console.log(`Backfilling GPS playback exports under ${DATASETS_ROOT}`);
  console.log(`Sessions matched: ${sessions.length}`);
  console.log(args.force ? "Mode: force regenerate" : "Mode: skip sessions that already have GPS playback exports");

  const summary = {
    matched: sessions.length,
    processed: 0,
    skipped_existing: 0,
    ok: 0,
    partial: 0,
    failed: 0
  };

  for (const sessionDir of sessions) {
    const sessionId = path.basename(sessionDir);
    const jsonPath = path.join(sessionDir, EXPORTS_DIRNAME, SESSION_GPS_PLAYBACK_NAME);
    const videoPath = path.join(sessionDir, EXPORTS_DIRNAME, SESSION_GPS_PLAYBACK_VIDEO_NAME);
    const baseMultiviewWithAudioPath = path.join(sessionDir, EXPORTS_DIRNAME, SESSION_MULTIVIEW_WITH_AUDIO_NAME);
    const combinedPath = path.join(sessionDir, EXPORTS_DIRNAME, SESSION_MULTIVIEW_WITH_AUDIO_AND_GPS_NAME);
    if (
      !args.force &&
      fs.existsSync(jsonPath) &&
      fs.existsSync(videoPath) &&
      (!fs.existsSync(baseMultiviewWithAudioPath) || fs.existsSync(combinedPath)) &&
      hasCombinedManifestEntry(sessionDir)
    ) {
      summary.skipped_existing += 1;
      console.log(`[skip] ${sessionId} already has ${path.relative(sessionDir, jsonPath)}, ${path.relative(sessionDir, videoPath)}, and combined export metadata`);
      continue;
    }

    const startedAt = Date.now();
    const jsonResult = exportSessionGpsPlaybackForSession({ sessionDir, outPath: jsonPath });
    let videoResult = {
      ok: true,
      skipped: true,
      reason: jsonResult.ok ? "no_gps_tracks" : "gps_playback_export_failed",
      path: videoPath
    };
    if (jsonResult.ok && Number(jsonResult.devices_with_gps || 0) > 0) {
      videoResult = await renderGpsPlaybackVideo({
        inputJsonPath: jsonPath,
        outPath: videoPath
      });
    }
    let combinedResult = {
      ok: true,
      skipped: true,
      reason: !videoResult.ok || videoResult.skipped
        ? "gps_playback_video_missing"
        : (!fs.existsSync(baseMultiviewWithAudioPath) ? "multiview_with_audio_missing" : "unavailable"),
      path: combinedPath
    };
    if (videoResult.ok && !videoResult.skipped && fs.existsSync(baseMultiviewWithAudioPath)) {
      combinedResult = await composeMultiviewWithAudioAndGps({
        baseVideoPath: baseMultiviewWithAudioPath,
        gpsVideoPath: videoPath,
        outPath: combinedPath
      });
    }
    patchExportManifest(sessionDir, jsonPath, videoPath, combinedPath);
    const status = !jsonResult.ok || !videoResult.ok || !combinedResult.ok
      ? "failed"
      : (videoResult.skipped || combinedResult.skipped ? "partial" : "ok");
    appendControlLog(path.join(sessionDir, "control_log.jsonl"), {
      type: "session_gps_playback_export",
      mode: "backfill",
      at_iso: new Date().toISOString(),
      options: {
        force: !!args.force
      },
      duration_ms: Date.now() - startedAt,
      result: {
        gpsPlaybackJson: jsonResult,
        gpsPlaybackVideo: videoResult,
        multiviewWithAudioAndGps: combinedResult
      }
    });

    summary.processed += 1;
    if (status === "ok") {
      summary.ok += 1;
      console.log(`[ok] ${sessionId} | devices_with_gps: ${Number(jsonResult.devices_with_gps || 0)} | video: ${path.basename(videoPath)} | combined: ${path.basename(combinedPath)}`);
    } else if (status === "partial") {
      summary.partial += 1;
      console.log(`[partial] ${sessionId} | devices_with_gps: ${Number(jsonResult.devices_with_gps || 0)} | video: ${videoResult.skipped ? (videoResult.reason || "skipped") : "ok"} | combined: ${combinedResult.skipped ? (combinedResult.reason || "skipped") : "ok"}`);
    } else {
      summary.failed += 1;
      console.log(`[failed] ${sessionId} | json_error: ${jsonResult.error || "-"} | video_error: ${videoResult.error || "-"} | combined_error: ${combinedResult.error || "-"}`);
    }
  }

  console.log("");
  console.log("Summary");
  console.log(
    `matched=${summary.matched} processed=${summary.processed} skipped_existing=${summary.skipped_existing} ok=${summary.ok} partial=${summary.partial} failed=${summary.failed}`
  );

  return summary.partial > 0 || summary.failed > 0 ? 1 : 0;
}

function parseArgs(argv) {
  const out = {
    help: false,
    force: false,
    sessions: []
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--force") {
      out.force = true;
      continue;
    }
    if (arg === "--session") {
      const value = argv[i + 1];
      if (!value) throw new Error("--session requires a value");
      out.sessions.push(value);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return out;
}

function resolveSessions(args) {
  if (!fs.existsSync(DATASETS_ROOT)) return [];
  if (args.sessions.length) {
    return args.sessions
      .map((sessionId) => path.join(DATASETS_ROOT, sessionId))
      .filter((sessionDir) => fs.existsSync(sessionDir) && fs.statSync(sessionDir).isDirectory())
      .sort();
  }
  return fs.readdirSync(DATASETS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("session_"))
    .map((entry) => path.join(DATASETS_ROOT, entry.name))
    .sort();
}

function appendControlLog(controlLogPath, entry) {
  try {
    fs.appendFileSync(controlLogPath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {}
}

function patchExportManifest(sessionDir, jsonPath, videoPath, combinedPath) {
  const manifestPath = path.join(sessionDir, EXPORTS_DIRNAME, SESSION_MULTIVIEW_MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) return;
  try {
    const raw = fs.readFileSync(manifestPath, "utf8");
    const payload = JSON.parse(raw);
    if (!payload || typeof payload !== "object") return;
    if (!payload.exports || typeof payload.exports !== "object") payload.exports = {};
    payload.exports.session_gps_playback = path.relative(sessionDir, jsonPath);
    payload.exports.session_gps_playback_video = path.relative(sessionDir, videoPath);
    payload.exports.session_multiview_with_audio_and_gps = path.relative(sessionDir, combinedPath);
    fs.writeFileSync(manifestPath, JSON.stringify(payload, null, 2), "utf8");
  } catch {}
}

function hasCombinedManifestEntry(sessionDir) {
  const manifestPath = path.join(sessionDir, EXPORTS_DIRNAME, SESSION_MULTIVIEW_MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) return false;
  try {
    const payload = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return !!payload?.exports && Object.prototype.hasOwnProperty.call(payload.exports, "session_multiview_with_audio_and_gps");
  } catch {
    return false;
  }
}

function printUsage() {
  console.log("Usage: node scripts/backfill-session-gps-playback.js [options]");
  console.log("");
  console.log("Generates exports/session_gps_playback.json, exports/session_gps_playback.mp4, and");
  console.log("exports/session_multiview_with_audio_and_gps.mp4 when session_multiview_with_audio.mp4 exists.");
  console.log("");
  console.log("Options:");
  console.log("  --session <session_id>   Backfill only the given session. Repeat to include multiple.");
  console.log("  --force                  Regenerate even if a GPS playback export already exists.");
  console.log("  --help                   Show this help text.");
}

try {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(String(err?.message || err));
      process.exitCode = 1;
    });
} catch (err) {
  console.error(String(err?.message || err));
  process.exitCode = 1;
}
