import express from "express";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PAIR_TOKEN = process.env.PAIR_TOKEN;
const CALLBACK_URL = process.env.CALLBACK_URL || "";
const PORT = Number(process.env.PORT) || 8080;

if (!PAIR_TOKEN) {
  console.error("Missing PAIR_TOKEN env var. Set it to the pairing token from StreamCast.");
  process.exit(1);
}

// stream_id -> { proc, meta }
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

function driveDirectUrl(url) {
  const id = extractDriveId(url);
  if (!id) return url;
  return `https://drive.google.com/uc?export=download&id=${id}`;
}

async function report(streamId, status, error) {
  if (!CALLBACK_URL) return;
  try {
    await fetch(CALLBACK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${PAIR_TOKEN}`,
      },
      body: JSON.stringify({ stream_id: streamId, status, error }),
    });
  } catch (e) {
    console.error("callback failed", e);
  }
}

app.get("/health", (_req, res) => res.json({ ok: true, jobs: jobs.size }));

app.post("/stream/start", auth, async (req, res) => {
  const { stream_id, drive_url, rtmp_url, rtmp_key, loop } = req.body || {};
  if (!stream_id || !drive_url || !rtmp_url || !rtmp_key) {
    return res.status(400).json({ error: "missing fields" });
  }
  if (jobs.has(stream_id)) return res.status(409).json({ error: "already running" });

  const input = driveDirectUrl(drive_url);
  const dest = rtmp_url.replace(/\/+$/, "") + "/" + rtmp_key;

  const args = [
    "-re",
    ...(loop ? ["-stream_loop", "-1"] : []),
    "-i", input,
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

  console.log("[start]", stream_id, "→", rtmp_url);
  const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  const runId = randomUUID();
  jobs.set(stream_id, { proc, runId });

  proc.stderr.on("data", (d) => process.stdout.write(`[ff:${stream_id}] ${d}`));
  proc.on("exit", (code, signal) => {
    console.log("[exit]", stream_id, code, signal);
    const job = jobs.get(stream_id);
    if (!job || job.runId !== runId) return;
    jobs.delete(stream_id);
    if (code === 0 || signal === "SIGTERM" || signal === "SIGKILL") {
      report(stream_id, "stopped");
    } else {
      report(stream_id, "error", `ffmpeg exited with code ${code}`);
    }
  });

  report(stream_id, "live");
  res.json({ ok: true });
});

app.post("/stream/stop", auth, (req, res) => {
  const { stream_id } = req.body || {};
  const job = jobs.get(stream_id);
  if (!job) return res.json({ ok: true, note: "not running" });
  job.proc.kill("SIGTERM");
  setTimeout(() => { try { job.proc.kill("SIGKILL"); } catch {} }, 5000);
  res.json({ ok: true });
});

app.get("/", (_req, res) => res.type("text/plain").send("StreamCast worker ✓"));

app.listen(PORT, () => console.log("StreamCast worker listening on :" + PORT));
