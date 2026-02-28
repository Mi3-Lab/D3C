const { spawn } = require("child_process");
const path = require("path");

function convertSessionCsvToParquet({ sessionDir, pythonBin, timeoutMs = 10 * 60 * 1000 }) {
  const py = pythonBin || process.env.PARQUET_PYTHON_BIN || "python";
  const script = path.join(__dirname, "write_parquet.py");

  return new Promise((resolve) => {
    const proc = spawn(py, [script, "--session-dir", sessionDir], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { proc.kill(); } catch {}
      resolve({ ok: false, error: `parquet conversion timeout after ${timeoutMs}ms`, stdout, stderr });
    }, timeoutMs);

    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    proc.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, error: err.message, stdout, stderr });
    });

    proc.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, error: `python exit ${code}`, stdout, stderr });
        return;
      }
      let parsed = null;
      try { parsed = JSON.parse(stdout || "{}"); } catch {}
      resolve(parsed && typeof parsed === "object" ? parsed : { ok: true, stdout, stderr });
    });
  });
}

module.exports = {
  convertSessionCsvToParquet
};
