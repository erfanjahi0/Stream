import express from "express";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, statSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PAIR_TOKEN = process.env.PAIR_TOKEN;
const CALLBACK_URL = process.env.CALLBACK_URL || "";
const PORT = Number(process.env.PORT) || 8080;
const CACHE_DIR = process.env.CACHE_DIR || "/tmp/streamcast";

if (!PAIR_TOKEN) {
  console.error("Missing PAIR_TOKEN env var. Set it to the pairing token from StreamCast.");
  process.exit(1);
}

mkdirSync(CACHE_DIR, { recursive: true });

// stream_id -> { proc, runId, downloader, cancelled }
const jobs = new Map();

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.replace(/^Bearer\s+/i, "");
  if (token !== PAIR_TOKEN) return res.status(401).json({ error: "bad token" });
  next();
}

function extractDriveId(url) {
  const m1 = url.match(/\/file\/d\/([^/]+)/);
  if (m1) return m1[1];
  const m2 = url.match(/[?&]id=([^&]+)/);
  if (m2) return m2[1];
  return null;
}

// Google Drive returns an HTML "can't scan for viruses" interstitial for files
// larger than ~100MB on the classic /uc endpoint. The usercontent host with
// confirm=t bypasses it and streams raw bytes.
function driveDirectUrl(url) {
  const id = extractDriveId(url);
  if (!id) return url;
  return `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t&authuser=0`;
}

async function report(streamId, status, error, extra) {
  if (!CALLBACK_URL) return;
  try {
    await fetch(CALLBACK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${PAIR_TOKEN}`,
      },
      body: JSON.stringify({ stream_id: streamId, status, error, ...(extra || {}) }),
    });
  } catch (e) {
    console.error("callback failed", e);
  }
}

function cachePathFor(driveUrl) {
  const id = extractDriveId(driveUrl) || createHash("sha1").update(driveUrl).digest("hex");
  return join(CACHE_DIR, `${id}.mp4`);
}

// Download the whole file to disk first (with resume). Streaming 3GB+ directly
// from Google Drive over hours is unreliable — connections drop and there's no
// way for ffmpeg to resume mid-file, which kills the livestream.
function downloadToDisk(streamId, driveUrl, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const url = driveDirectUrl(driveUrl);
    // curl -L follows redirects, -C - resumes if a partial file exists,
    // --retry keeps trying on transient network errors.
    const args = [
      "-L", "-C", "-",
      "--retry", "10",
      "--retry-delay", "5",
      "--retry-all-errors",
      "--fail",
      "-A", "Mozilla/5.0 (compatible; StreamCast/1.0)",
      "-o", destPath,
      "--progress-bar",
      url,
    ];
    console.log("[dl]", streamId, "→", destPath);
    const proc = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"] });
    const job = jobs.get(streamId);
    if (job) job.downloader = proc;

    let errTail = "";
    let lastReport = 0;
    proc.stderr.on("data", (d) => {
      const s = d.toString();
      errTail = (errTail + s).slice(-2000);
      // curl progress bar prints \r-separated chunks like "  42.3%"
      const m = s.match(/([\d.]+)%/g);
      if (m && onProgress) {
        const pct = parseFloat(m[m.length - 1]);
        const now = Date.now();
        if (!isNaN(pct) && now - lastReport > 2000) {
          lastReport = now;
          onProgress(pct);
        }
      }
    });
    proc.on("exit", (code, signal) => {
      if (signal === "SIGTERM" || signal === "SIGKILL") return reject(new Error("cancelled"));
      if (code === 0) return resolve();
      reject(new Error(`curl exited ${code}: ${errTail.split("\n").slice(-3).join(" | ")}`));
    });
    proc.on("error", (e) => reject(e));
  });
}

app.get("/health", (_req, res) => res.json({ ok: true, jobs: jobs.size }));

app.post("/stream/start", auth, async (req, res) => {
  const { stream_id, drive_url, rtmp_url, rtmp_key, loop } = req.body || {};
  if (!stream_id || !drive_url || !rtmp_url || !rtmp_key) {
    return res.status(400).json({ error: "missing fields" });
  }
  if (jobs.has(stream_id)) return res.status(409).json({ error: "already running" });

  const localPath = cachePathFor(drive_url);
  jobs.set(stream_id, { runId: randomUUID(), cancelled: false });

  // Respond right away so the dashboard doesn't hang for the download.
  // The rest of the pipeline reports progress via the callback.
  res.json({ ok: true, cache_path: localPath });

  const job = jobs.get(stream_id);
  const runId = job.runId;

  try {
    // 1. Download (or resume) the file to local disk unless it's already cached.
    if (!existsSync(localPath) || statSync(localPath).size === 0) {
      report(stream_id, "starting", null, { phase: "downloading", progress: 0 });
      await downloadToDisk(stream_id, drive_url, localPath, (pct) => {
        console.log(`[dl] ${stream_id} ${pct.toFixed(1)}%`);
        report(stream_id, "starting", null, { phase: "downloading", progress: pct });
      });
    } else {
      console.log("[dl] cached", localPath, statSync(localPath).size, "bytes");
    }

    if (!jobs.has(stream_id) || jobs.get(stream_id).cancelled) return;

    // 2. Start ffmpeg from the local file.
    const dest = rtmp_url.replace(/\/+$/, "") + "/" + rtmp_key;
    const args = [
      "-re",
      ...(loop ? ["-stream_loop", "-1"] : []),
      "-i", localPath,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-b:v", "4500k",
      "-maxrate", "4500k",
      "-bufsize", "9000k",
      "-pix_fmt", "yuv420p",
      "-g", "60",
      "-c:a", "aac",
      "-b:a", "160k",
      "-ar", "44100",
      "-f", "flv",
      dest,
    ];

    console.log("[ff]", stream_id, "→", rtmp_url);
    report(stream_id, "starting", null, { phase: "connecting" });
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    jobs.set(stream_id, { ...jobs.get(stream_id), proc });

    let announcedLive = false;
    let stderrTail = "";
    proc.stderr.on("data", (d) => {
      const s = d.toString();
      process.stdout.write(`[ff:${stream_id}] ${s}`);
      stderrTail = (stderrTail + s).slice(-4000);
      if (!announcedLive && /frame=\s*\d+/.test(s)) {
        announcedLive = true;
        report(stream_id, "live");
      }
    });
    proc.on("exit", (code, signal) => {
      console.log("[exit]", stream_id, code, signal);
      const current = jobs.get(stream_id);
      if (!current || current.runId !== runId) return;
      jobs.delete(stream_id);
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        report(stream_id, "stopped");
      } else if (code === 0 && announcedLive) {
        report(stream_id, "stopped");
      } else {
        const tail = stderrTail.split("\n").filter(Boolean).slice(-6).join(" | ");
        report(stream_id, "error", `ffmpeg exited (code ${code}): ${tail}`);
      }
    });
  } catch (e) {
    console.error("[pipeline]", stream_id, e);
    jobs.delete(stream_id);
    report(stream_id, "error", e instanceof Error ? e.message : String(e));
  }
});

app.post("/stream/stop", auth, (req, res) => {
  const { stream_id } = req.body || {};
  const job = jobs.get(stream_id);
  if (!job) return res.json({ ok: true, note: "not running" });
  job.cancelled = true;
  try { job.downloader && job.downloader.kill("SIGTERM"); } catch {}
  try { job.proc && job.proc.kill("SIGTERM"); } catch {}
  setTimeout(() => {
    try { job.downloader && job.downloader.kill("SIGKILL"); } catch {}
    try { job.proc && job.proc.kill("SIGKILL"); } catch {}
  }, 5000);
  res.json({ ok: true });
});

// Optional maintenance endpoint: wipe the download cache.
app.post("/cache/clear", auth, (_req, res) => {
  let removed = 0;
  for (const f of readdirSync(CACHE_DIR)) {
    try { unlinkSync(join(CACHE_DIR, f)); removed++; } catch {}
  }
  res.json({ ok: true, removed });
});

app.get("/", (_req, res) => res.type("text/plain").send("StreamCast worker ✓"));

app.listen(PORT, () => console.log("StreamCast worker listening on :" + PORT));
