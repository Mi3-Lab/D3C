#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const {
  exportSessionMedia,
  EXPORTS_DIRNAME,
  SESSION_MULTIVIEW_MANIFEST_NAME
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

  console.log(`Backfilling session exports under ${DATASETS_ROOT}`);
  console.log(`Sessions matched: ${sessions.length}`);
  if (args.force) console.log("Mode: force regenerate");
  else console.log("Mode: skip sessions that already have export manifests");

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
    const manifestPath = path.join(sessionDir, EXPORTS_DIRNAME, SESSION_MULTIVIEW_MANIFEST_NAME);
    if (!args.force && fs.existsSync(manifestPath)) {
      summary.skipped_existing += 1;
      console.log(`[skip] ${sessionId} already has ${path.relative(sessionDir, manifestPath)}`);
      continue;
    }

    const startedAt = Date.now();
    let result = null;
    let status = "ok";
    try {
      result = await exportSessionMedia({
        sessionDir,
        ffmpegBin: args.ffmpegBin,
        audioDeviceId: args.audioDeviceId,
        force: args.force
      });
      if (!result.ok) status = "failed";
      else if (result.had_errors) status = "partial";
    } catch (err) {
      status = "failed";
      result = { ok: false, error: String(err?.message || err) };
    }

    appendControlLog(path.join(sessionDir, "control_log.jsonl"), {
      type: "session_export",
      mode: "backfill",
      at_iso: new Date().toISOString(),
      options: {
        force: !!args.force,
        ffmpeg_bin: args.ffmpegBin,
        audio_device_id: args.audioDeviceId || null
      },
      duration_ms: Date.now() - startedAt,
      result
    });

    summary.processed += 1;
    if (status === "ok") summary.ok += 1;
    else if (status === "partial") summary.partial += 1;
    else summary.failed += 1;

    const failures = collectFailures(result);
    const failureNote = failures.length ? ` | issues: ${failures.join(", ")}` : "";
    const errorNote = result?.error ? ` | error: ${result.error}` : "";
    console.log(`[${status}] ${sessionId}${failureNote}${errorNote}`);
  }

  console.log("");
  console.log("Summary");
  console.log(`matched=${summary.matched} processed=${summary.processed} skipped_existing=${summary.skipped_existing} ok=${summary.ok} partial=${summary.partial} failed=${summary.failed}`);

  return summary.partial > 0 || summary.failed > 0 ? 1 : 0;
}

function parseArgs(argv) {
  const out = {
    help: false,
    force: false,
    ffmpegBin: process.env.FFMPEG_BIN || "ffmpeg",
    audioDeviceId: null,
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
    if (arg === "--audio-device") {
      const value = argv[i + 1];
      if (!value) throw new Error("--audio-device requires a value");
      out.audioDeviceId = value;
      i += 1;
      continue;
    }
    if (arg === "--ffmpeg-bin") {
      const value = argv[i + 1];
      if (!value) throw new Error("--ffmpeg-bin requires a value");
      out.ffmpegBin = value;
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

function collectFailures(result) {
  if (!result || !result.ok) return [];
  const failures = [];

  for (const [name, exportResult] of Object.entries(result.exports || {})) {
    if (exportResult && exportResult.ok === false) failures.push(name);
  }

  for (const [deviceId, deviceResult] of Object.entries(result.devices || {})) {
    if (deviceResult?.camera_video?.ok === false) failures.push(`${deviceId}:camera_video`);
    if (deviceResult?.camera_with_audio?.ok === false) failures.push(`${deviceId}:camera_with_audio`);
  }

  return failures;
}

function printUsage() {
  console.log("Usage: node scripts/backfill-session-exports.js [options]");
  console.log("");
  console.log("Options:");
  console.log("  --session <session_id>     Backfill only the given session. Repeat to include multiple.");
  console.log("  --force                    Regenerate even if an export manifest already exists.");
  console.log("  --audio-device <device_id> Override the default audio source device.");
  console.log("  --ffmpeg-bin <path>        Path to ffmpeg. Defaults to FFMPEG_BIN or 'ffmpeg'.");
  console.log("  --help                     Show this help text.");
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(String(err?.message || err));
    process.exitCode = 1;
  });
