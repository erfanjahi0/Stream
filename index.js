const express = require('express');
const { spawn } = require('child_process');

const app = express();
app.use(express.json());

const TOKEN = process.env.STREAM_TOKEN;
const PORT = process.env.PORT || 3000;

let ffmpegProcess = null;
let isStreaming = false;

function authMiddleware(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || auth !== `Bearer ${TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.post('/start', authMiddleware, (req, res) => {
  if (isStreaming) {
    return res.status(409).json({ error: 'Already streaming' });
  }

  const { videoUrl, streamKey, rtmpUrl = 'rtmp://a.rtmp.youtube.com/live2' } = req.body;

  if (!videoUrl || !streamKey) {
    return res.status(400).json({ error: 'videoUrl and streamKey are required' });
  }

  const rtmpTarget = `${rtmpUrl}/${streamKey}`;
  console.log('[StreamCast] Starting stream to', rtmpTarget);

  ffmpegProcess = spawn('ffmpeg', [
    '-re',
    '-stream_loop', '-1',
    '-i', videoUrl,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-b:v', '3000k',
    '-maxrate', '3000k',
    '-bufsize', '6000k',
    '-pix_fmt', 'yuv420p',
    '-g', '50',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-ar', '44100',
    '-f', 'flv',
    rtmpTarget,
  ]);

  ffmpegProcess.stdout.on('data', (d) => process.stdout.write(d));
  ffmpegProcess.stderr.on('data', (d) => process.stderr.write(d));

  ffmpegProcess.on('close', (code) => {
    console.log('[StreamCast] FFmpeg exited with code', code);
    isStreaming = false;
    ffmpegProcess = null;
  });

  isStreaming = true;
  res.json({ success: true, message: 'Stream started' });
});

app.post('/stop', authMiddleware, (req, res) => {
  if (!isStreaming || !ffmpegProcess) {
    return res.status(409).json({ error: 'Not currently streaming' });
  }

  ffmpegProcess.kill('SIGTERM');
  isStreaming = false;
  ffmpegProcess = null;
  console.log('[StreamCast] Stream stopped');
  res.json({ success: true, message: 'Stream stopped' });
});

app.get('/status', authMiddleware, (req, res) => {
  res.json({ streaming: isStreaming, pid: ffmpegProcess ? ffmpegProcess.pid : null });
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`[StreamCast] Worker running on port ${PORT}`);
  if (!TOKEN) console.warn('[StreamCast] WARNING: STREAM_TOKEN is not set!');
});
