// ═══════════════════════════════════════════════════════════════
//  StreamForge — Express Server + Socket.io
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

// ─── Routes ───

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    streams: streamManager.streams.size,
    maxStreams: streamManager.maxConcurrent,
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

// Start a stream: download from Drive → start FFmpeg RTMP
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

    // Use ephemeral container storage (Railway gives up to 1TB)
    const tempDir = path.join(DOWNLOAD_DIR);

    const downloadId = `dl_${Date.now()}`;
    res.json({
      success: true,
      message: shortsMode
        ? 'Download started. Shorts vertical stream will begin when download completes.'
        : 'Download started. Stream will begin automatically when download completes.',
      downloadId,
      fileId,
      shortsMode,
    });

    console.log(`[${downloadId}] Starting download for file ${fileId}...`);

    try {
      const result = await downloadFile(fileId, tempDir, (progress) => {
        io.emit('download:progress', { downloadId, fileId, ...progress });
      });

      console.log(`[${downloadId}] Download complete: ${result.path} (${formatBytes(result.size)})`);

      io.emit('download:complete', {
        downloadId, fileId,
        path: result.path, size: result.size, name: result.name,
      });

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

      console.log(`[${downloadId}] Stream started: ${streamId} (shorts: ${shortsMode})`);
    } catch (err) {
      console.error(`[${downloadId}] Error:`, err.message);
      io.emit('download:error', { downloadId, fileId, error: err.message });
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Stop a stream
app.post('/api/stream/:id/stop', (req, res) => {
  try {
    const { id } = req.params;
    streamManager.stopStream(id);
    res.json({ success: true, message: 'Stream stopping...' });
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

// ─── Helpers ───

// ─── Start ───
server.listen(PORT, () => {
  console.log(`╔══════════════════════════════════════════╗`);
  console.log(`║  StreamForge v1.0.0                      ║`);
  console.log(`║  Listening on http://localhost:${PORT}       ║`);
  console.log(`║  Max streams: ${streamManager.maxConcurrent}                        ║`);
  console.log(`║  Download dir: ${DOWNLOAD_DIR}  ║`);
  console.log(`╚══════════════════════════════════════════╝`);
});

module.exports = { app, server, io };
