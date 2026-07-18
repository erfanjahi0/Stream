// ═══════════════════════════════════════════════════════════════
//  StreamForge — Express Server + Socket.io v3
//  Fixed streaming, file management, delete streams
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config();

const StreamManager = require('./streamManager');
const { extractFileId, getFileInfo, downloadFile, formatBytes } = require('./driveDownloader');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const streamManager = new StreamManager(io);

const PORT = process.env.PORT || 3000;
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || '/tmp/streamforge/downloads';

// Ensure download directory exists
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

// ─── Middleware ───
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// FFmpeg status endpoint
app.get('/api/ffmpeg-status', (req, res) => {
  res.json({
    found: !!process.env.FFMPEG_PATH || ffmpegAvailable,
    path: process.env.FFMPEG_PATH || (ffmpegAvailable ? 'ffmpeg (system PATH)' : null),
  });
});

// ═══════════════════════════════════════════════════════════════
//  FILE MANAGEMENT API
// ═══════════════════════════════════════════════════════════════

// List all downloaded files
app.get('/api/files', (req, res) => {
  try {
    const files = fs.readdirSync(DOWNLOAD_DIR)
      .filter(f => !f.startsWith('.'))
      .map(f => {
        const filePath = path.join(DOWNLOAD_DIR, f);
        const stat = fs.statSync(filePath);
        return {
          name: f,
          path: filePath,
          size: stat.size,
          sizeFormatted: formatBytes(stat.size),
          modified: stat.mtime,
        };
      })
      .sort((a, b) => b.modified - a.modified);

    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a downloaded file
app.delete('/api/files/:name', (req, res) => {
  try {
    const fileName = path.basename(req.params.name);
    const filePath = path.join(DOWNLOAD_DIR, fileName);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    fs.unlinkSync(filePath);
    io.emit('files:changed');
    res.json({ success: true, message: `Deleted ${fileName}` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  STREAM MANAGEMENT API
// ═══════════════════════════════════════════════════════════════

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    streams: streamManager.streams.size,
    maxStreams: streamManager.maxConcurrent,
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg (system)',
    downloadDir: DOWNLOAD_DIR,
    timestamp: new Date().toISOString(),
  });
});

// Preview Google Drive file info
app.post('/api/preview', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'No URL provided' });

    const fileId = extractFileId(url);
    const info = await getFileInfo(fileId);

    res.json({
      success: true,
      fileId,
      name: info.name,
      size: info.size,
      sizeFormatted: formatBytes(info.size),
      mime: info.mime,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Download only (no stream) — for pre-downloading files
app.post('/api/download', async (req, res) => {
  try {
    const { driveUrl } = req.body;
    if (!driveUrl) return res.status(400).json({ error: 'Google Drive URL is required' });

    const fileId = extractFileId(driveUrl);
    const downloadId = `dl_${Date.now()}`;

    res.json({
      success: true,
      message: 'Download started',
      downloadId,
      fileId,
    });

    console.log(`[${downloadId}] Starting download for file ${fileId}...`);

    try {
      const result = await downloadFile(fileId, DOWNLOAD_DIR, (progress) => {
        io.emit('download:progress', { downloadId, fileId, ...progress });
      });

      console.log(`[${downloadId}] Download complete: ${result.path}`);
      io.emit('download:complete', { downloadId, fileId, ...result });
      io.emit('files:changed');
    } catch (err) {
      console.error(`[${downloadId}] Error:`, err.message);
      io.emit('download:error', { downloadId, fileId, error: err.message });
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Start stream from Google Drive (download → stream)
app.post('/api/stream/start', async (req, res) => {
  try {
    const {
      driveUrl,
      rtmpUrl,
      streamKey,
      loop = false,
      resolution = '1080p',
      bitrate = '6000k',
      fps = 30,
      shortsMode = false,
      shortsFit = 'crop',
    } = req.body;

    if (!driveUrl) return res.status(400).json({ error: 'Google Drive URL is required' });
    if (!streamKey) return res.status(400).json({ error: 'YouTube stream key is required' });

    const finalRtmpUrl = rtmpUrl || process.env.YOUTUBE_RTMP_URL || 'rtmp://a.rtmp.youtube.com/live2';
    const fileId = extractFileId(driveUrl);
    const downloadId = `dl_${Date.now()}`;

    res.json({
      success: true,
      message: 'Download started. Stream will begin when download completes.',
      downloadId,
      fileId,
    });

    console.log(`[${downloadId}] Starting download for file ${fileId}...`);

    try {
      const result = await downloadFile(fileId, DOWNLOAD_DIR, (progress) => {
        io.emit('download:progress', { downloadId, fileId, ...progress });
      });

      console.log(`[${downloadId}] Download complete: ${result.path} (${formatBytes(result.size)})`);
      io.emit('download:complete', { downloadId, fileId, ...result });

      // Start the stream
      const streamId = streamManager.startStream({
        filePath: result.path,
        fileName: result.name,
        rtmpUrl: finalRtmpUrl,
        streamKey,
        loop,
        resolution,
        bitrate,
        fps,
        shortsMode,
        shortsFit,
      });

      io.emit('stream:started', {
        downloadId, streamId,
        fileName: result.name,
        fileSize: result.size,
        shortsMode,
      });

      console.log(`[${downloadId}] Stream started: ${streamId}`);
    } catch (err) {
      console.error(`[${downloadId}] Error:`, err.message);
      io.emit('download:error', { downloadId, fileId, error: err.message });
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Start stream from an existing downloaded file
app.post('/api/stream/file', (req, res) => {
  try {
    const {
      fileName,
      rtmpUrl,
      streamKey,
      loop = false,
      resolution = '1080p',
      bitrate = '6000k',
      fps = 30,
      shortsMode = false,
      shortsFit = 'crop',
    } = req.body;

    if (!fileName) return res.status(400).json({ error: 'File name is required' });
    if (!streamKey) return res.status(400).json({ error: 'YouTube stream key is required' });

    const finalRtmpUrl = rtmpUrl || process.env.YOUTUBE_RTMP_URL || 'rtmp://a.rtmp.youtube.com/live2';
    const filePath = path.join(DOWNLOAD_DIR, path.basename(fileName));

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: `File not found: ${fileName}` });
    }

    const stat = fs.statSync(filePath);

    let streamId;
    try {
      streamId = streamManager.startStream({
        filePath,
        fileName: path.basename(fileName),
        rtmpUrl: finalRtmpUrl,
        streamKey,
        loop,
        resolution,
        bitrate,
        fps,
        shortsMode,
        shortsFit,
      });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    res.json({
      success: true,
      message: 'Stream started from existing file',
      streamId,
      fileName: path.basename(fileName),
      fileSize: stat.size,
    });

    io.emit('stream:started', {
      streamId,
      fileName: path.basename(fileName),
      fileSize: stat.size,
      shortsMode,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Stop a stream
app.post('/api/stream/:id/stop', (req, res) => {
  try {
    streamManager.stopStream(req.params.id);
    res.json({ success: true, message: 'Stream stopping...' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete a stream record
app.delete('/api/stream/:id', (req, res) => {
  try {
    streamManager.deleteStream(req.params.id);
    res.json({ success: true, message: 'Stream deleted' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get all streams
app.get('/api/streams', (req, res) => {
  res.json({ streams: streamManager.getAllStreams() });
});

// Get stream details
app.get('/api/stream/:id', (req, res) => {
  const stream = streamManager.getStream(req.params.id);
  if (!stream) return res.status(404).json({ error: 'Stream not found' });
  res.json({
    id: stream.id,
    fileName: stream.fileName,
    status: stream.status,
    resolution: stream.resolution,
    bitrate: stream.bitrate,
    fps: stream.fps,
    loop: stream.loop,
    shortsMode: stream.shortsMode,
    startedAt: stream.startedAt,
    uptimeSeconds: stream.uptimeSeconds,
    stats: stream.stats,
    logs: stream.logs.slice(-50),
  });
});

// Get stream logs
app.get('/api/stream/:id/logs', (req, res) => {
  const logs = streamManager.getStreamLogs(req.params.id, 200);
  res.json({ logs });
});

// ─── Socket.io ───
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.on('stream:subscribe', (streamId) => {
    socket.join(`stream:${streamId}`);
  });

  socket.on('stream:unsubscribe', (streamId) => {
    socket.leave(`stream:${streamId}`);
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

// ─── Verify ffmpeg is installed before starting ───
const { execSync } = require('child_process');

let ffmpegAvailable = false;

function findFfmpeg() {
  // Check common paths
  const commonPaths = [
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/opt/homebrew/bin/ffmpeg',
  ];

  for (const p of commonPaths) {
    try {
      execSync(`${p} -version`, { stdio: 'ignore' });
      console.log(`[StreamForge] FFmpeg found at: ${p}`);
      process.env.FFMPEG_PATH = p;
      ffmpegAvailable = true;
      return p;
    } catch (e) {}
  }

  // Try which
  try {
    const which = execSync('which ffmpeg 2>/dev/null', { encoding: 'utf8' }).trim();
    if (which) {
      console.log(`[StreamForge] FFmpeg found via which: ${which}`);
      process.env.FFMPEG_PATH = which;
      ffmpegAvailable = true;
      return which;
    }
  } catch (e) {}

  console.error('[StreamForge] WARNING: FFmpeg not found! Streams will fail.');
  console.error('[StreamForge] Make sure ffmpeg is installed in the container.');
  console.error('[StreamForge] The nixpacks.toml should install it via aptPkgs: ["ffmpeg"]');
  ffmpegAvailable = false;
  return null;
}

const ffmpegPath = findFfmpeg();

// ─── Start ───
server.listen(PORT, () => {
  console.log(`╔══════════════════════════════════════════╗`);
  console.log(`║  StreamForge v6.1.0                      ║`);
  console.log(`║  Listening on http://localhost:${PORT}       ║`);
  console.log(`║  Max streams: ${streamManager.maxConcurrent}                        ║`);
  console.log(`║  Download dir: ${DOWNLOAD_DIR}  ║`);
  console.log(`║  FFmpeg: ${ffmpegPath || 'NOT FOUND'} ${' '.repeat(Math.max(0, 26 - (ffmpegPath || 'NOT FOUND').length))}║`);
  console.log(`╚══════════════════════════════════════════╝`);

  if (!ffmpegPath) {
    console.error('');
    console.error('╔══════════════════════════════════════════════════╗');
    console.error('║  ⚠  FFMPEG NOT FOUND — STREAMS WILL FAIL        ║');
    console.error('║  Check nixpacks.toml has aptPkgs = ["ffmpeg"]   ║');
    console.error('╚══════════════════════════════════════════════════╝');
  }
});

module.exports = { app, server, io };
