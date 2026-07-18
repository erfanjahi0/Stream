// ═══════════════════════════════════════════════════════════════
//  StreamForge — Stream Manager v2
//  FFmpeg RTMP with YouTube Shorts (9:16 vertical) support
// ═══════════════════════════════════════════════════════════════

const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

class StreamManager {
  constructor(io) {
    this.io = io;
    this.streams = new Map();
    this.maxConcurrent = parseInt(process.env.MAX_CONCURRENT_STREAMS || '3', 10);
  }

  /**
   * Start streaming a local file to YouTube via RTMP.
   *
   * @param {object} opts
   * @param {string} opts.filePath     - Path to downloaded video
   * @param {string} opts.fileName     - Display name
   * @param {string} opts.rtmpUrl      - RTMP endpoint
   * @param {string} opts.streamKey    - Stream key
   * @param {boolean} opts.loop        - Loop video (24/7)
   * @param {string} opts.resolution   - Output resolution preset
   * @param {string} opts.bitrate      - Video bitrate
   * @param {number} opts.fps          - Frame rate
   * @param {boolean} opts.shortsMode  - YouTube Shorts 9:16 vertical mode
   * @param {string} opts.shortsFit    - How to fit: 'crop' (fill) or 'pad' (letterbox)
   * @returns {string} streamId
   */
  startStream(opts) {
    const {
      filePath,
      fileName,
      rtmpUrl,
      streamKey,
      loop = false,
      resolution = '1080p',
      bitrate = '6000k',
      fps = 30,
      shortsMode = false,
      shortsFit = 'crop',
    } = opts;

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    if (this.streams.size >= this.maxConcurrent) {
      throw new Error(`Max concurrent streams (${this.maxConcurrent}) reached`);
    }

    const id = uuidv4();
    const outputUrl = `${rtmpUrl}/${streamKey}`;

    // ─── Build video filter chain ───
    const { scaleFilter, finalResolution, finalBitrate } = this.buildVideoFilter(
      resolution, bitrate, shortsMode, shortsFit
    );

    // ─── Build FFmpeg arguments ───
    const ffmpegArgs = [];

    // Input
    if (loop) {
      ffmpegArgs.push('-stream_loop', '-1');
    }
    ffmpegArgs.push('-re', '-i', filePath);

    // Video encoding
    ffmpegArgs.push('-c:v', 'libx264');
    ffmpegArgs.push('-preset', 'veryfast');
    ffmpegArgs.push('-b:v', finalBitrate);
    ffmpegArgs.push('-maxrate', finalBitrate);
    ffmpegArgs.push('-bufsize', `${parseInt(finalBitrate) * 2}k`);
    ffmpegArgs.push('-pix_fmt', 'yuv420p');
    ffmpegArgs.push('-r', String(fps));

    if (scaleFilter) {
      ffmpegArgs.push('-vf', scaleFilter);
    }

    // Keyframe interval (2 seconds)
    ffmpegArgs.push('-g', String(fps * 2));
    ffmpegArgs.push('-keyint_min', String(fps * 2));

    // Audio
    ffmpegArgs.push('-c:a', 'aac');
    ffmpegArgs.push('-b:a', '128k');
    ffmpegArgs.push('-ar', '44100');
    ffmpegArgs.push('-ac', '2');

    // Output
    ffmpegArgs.push('-f', 'flv');
    ffmpegArgs.push('-flvflags', 'no_duration_filesize');
    ffmpegArgs.push(outputUrl);

    // Spawn FFmpeg
    const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
    const ffmpeg = spawn(ffmpegPath, ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

    const stream = {
      id,
      fileName,
      filePath,
      resolution: shortsMode ? `Shorts ${finalResolution}` : finalResolution,
      bitrate: finalBitrate,
      fps,
      loop,
      shortsMode,
      status: 'starting',
      startedAt: new Date(),
      ffmpeg,
      stats: {
        frame: 0, fps: 0, bitrate: 0, totalSize: 0,
        outTimeMs: 0, speed: 0, droppedFrames: 0, errors: 0,
      },
      logs: [],
      uptimeSeconds: 0,
    };

    this.streams.set(id, stream);

    // Parse FFmpeg stderr
    let logBuffer = '';

    ffmpeg.stderr.on('data', (data) => {
      const text = data.toString();
      logBuffer += text;

      const lines = text.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Parse stats
        const frameMatch = trimmed.match(/frame=\s*(\d+)/);
        const fpsMatch = trimmed.match(/fps=\s*([\d.]+)/);
        const bitrateMatch = trimmed.match(/bitrate=\s*([\d.]+)/);
        const sizeMatch = trimmed.match(/size=\s*(\d+)/);
        const timeMatch = trimmed.match(/time=\s*(\d+):(\d+):(\d+.\d+)/);
        const speedMatch = trimmed.match(/speed=\s*([\d.]+)x/);
        const dropMatch = trimmed.match(/drop=\s*(\d+)/);

        let statsUpdated = false;
        if (frameMatch) { stream.stats.frame = parseInt(frameMatch[1]); statsUpdated = true; }
        if (fpsMatch) { stream.stats.fps = parseFloat(fpsMatch[1]); statsUpdated = true; }
        if (bitrateMatch) { stream.stats.bitrate = parseFloat(bitrateMatch[1]); statsUpdated = true; }
        if (sizeMatch) { stream.stats.totalSize = parseInt(sizeMatch[1]) * 1024; statsUpdated = true; }
        if (speedMatch) { stream.stats.speed = parseFloat(speedMatch[1]); statsUpdated = true; }
        if (dropMatch) { stream.stats.droppedFrames = parseInt(dropMatch[1]); statsUpdated = true; }
        if (timeMatch) {
          const h = parseInt(timeMatch[1]);
          const m = parseInt(timeMatch[2]);
          const s = parseFloat(timeMatch[3]);
          stream.stats.outTimeMs = (h * 3600 + m * 60 + s) * 1000;
          statsUpdated = true;
        }

        if (statsUpdated) {
          stream.uptimeSeconds = (Date.now() - stream.startedAt.getTime()) / 1000;
          this.io.to(`stream:${id}`).emit('stream:stats', {
            id, stats: stream.stats, uptime: stream.uptimeSeconds,
          });
        }

        // Detect errors
        if (trimmed.toLowerCase().includes('error') ||
            trimmed.toLowerCase().includes('conversion failed') ||
            trimmed.toLowerCase().includes('could not')) {
          stream.stats.errors++;
          stream.logs.push({ level: 'error', text: trimmed, time: new Date() });
          this.io.to(`stream:${id}`).emit('stream:log', { id, level: 'error', text: trimmed });
        }
      }

      // Keep last 200 log lines
      const allLines = logBuffer.split('\n');
      if (allLines.length > 200) {
        logBuffer = allLines.slice(-200).join('\n');
      }
    });

    ffmpeg.on('close', (code) => {
      stream.status = code === 0 ? 'completed' : 'stopped';
      stream.endedAt = new Date();
      stream.uptimeSeconds = (stream.endedAt - stream.startedAt) / 1000;

      this.io.to(`stream:${id}`).emit('stream:ended', {
        id, status: stream.status, code, uptime: stream.uptimeSeconds,
      });

      // Clean up downloaded file after stream ends (ephemeral storage)
      if (process.env.CLEANUP_FILES !== 'false' && fs.existsSync(stream.filePath)) {
        try {
          fs.unlinkSync(stream.filePath);
          console.log(`[Stream ${id}] Cleaned up file: ${stream.filePath}`);
        } catch (e) {
          console.error(`[Stream ${id}] Failed to cleanup file:`, e.message);
        }
      }

      setTimeout(() => this.streams.delete(id), 5 * 60 * 1000);
    });

    ffmpeg.on('error', (err) => {
      stream.status = 'error';
      stream.logs.push({ level: 'error', text: err.message, time: new Date() });
      this.io.to(`stream:${id}`).emit('stream:error', { id, error: err.message });
    });

    // Mark as live after 3 seconds
    setTimeout(() => {
      if (stream.status === 'starting' && !ffmpeg.killed) {
        stream.status = 'live';
        this.io.to(`stream:${id}`).emit('stream:live', { id });
      }
    }, 3000);

    return id;
  }

  /**
   * Build the FFmpeg video filter chain based on resolution and shorts mode.
   *
   * Shorts mode transforms the video to 9:16 vertical (1080x1920 or 720x1280).
   * - 'crop' mode: scales to fill the frame, crops excess (best for full-screen shorts)
   * - 'pad' mode: scales to fit, adds black bars (preserves full content)
   */
  buildVideoFilter(resolution, bitrate, shortsMode, shortsFit) {
    // ─── Standard (landscape) resolutions ───
    const landscapeMap = {
      '1080p': { w: 1920, h: 1080 },
      '720p':  { w: 1280, h: 720 },
      '480p':  { w: 854, h: 480 },
      '360p':  { w: 640, h: 360 },
    };

    // ─── Shorts (vertical 9:16) resolutions ───
    const shortsMap = {
      '1080p': { w: 1080, h: 1920 },
      '720p':  { w: 720, h: 1280 },
      '480p':  { w: 480, h: 854 },
      '360p':  { w: 360, h: 640 },
    };

    // Bitrate adjustments for shorts (vertical needs less bandwidth)
    const shortsBitrateMap = {
      '12000k': '8000k',
      '6000k':  '4500k',
      '4500k':  '3000k',
      '3000k':  '2500k',
      '1500k':  '1200k',
      '800k':   '600k',
    };

    if (shortsMode) {
      const dims = shortsMap[resolution] || shortsMap['1080p'];
      const finalBitrate = shortsBitrateMap[bitrate] || '4500k';

      let filter;
      if (shortsFit === 'pad') {
        // Scale to fit within frame, pad with black bars
        filter = `scale=${dims.w}:${dims.h}:force_original_aspect_ratio=decrease,pad=${dims.w}:${dims.h}:(ow-iw)/2:(oh-ih)/2:color=black`;
      } else {
        // Scale to fill frame, crop excess (default — looks best for shorts)
        filter = `scale=${dims.w}:${dims.h}:force_original_aspect_ratio=increase,crop=${dims.w}:${dims.h}:(in_w-out_w)/2:(in_h-out_h)/2`;
      }

      return {
        scaleFilter: filter,
        finalResolution: `${dims.w}x${dims.h}`,
        finalBitrate,
      };
    }

    // Standard landscape
    if (resolution === 'original') {
      return { scaleFilter: null, finalResolution: 'original', finalBitrate: bitrate };
    }

    const dims = landscapeMap[resolution] || landscapeMap['1080p'];
    return {
      scaleFilter: `scale=${dims.w}:${dims.h}`,
      finalResolution: `${dims.w}x${dims.h}`,
      finalBitrate: bitrate,
    };
  }

  stopStream(id) {
    const stream = this.streams.get(id);
    if (!stream) throw new Error(`Stream not found: ${id}`);

    stream.status = 'stopping';
    stream.ffmpeg.kill('SIGTERM');

    setTimeout(() => {
      if (!stream.ffmpeg.killed) {
        stream.ffmpeg.kill('SIGKILL');
      }
    }, 5000);

    return true;
  }

  getStream(id) {
    return this.streams.get(id);
  }

  getAllStreams() {
    return Array.from(this.streams.values()).map((s) => ({
      id: s.id,
      fileName: s.fileName,
      status: s.status,
      resolution: s.resolution,
      bitrate: s.bitrate,
      fps: s.fps,
      loop: s.loop,
      shortsMode: s.shortsMode,
      startedAt: s.startedAt,
      uptimeSeconds: s.uptimeSeconds,
      stats: s.stats,
    }));
  }

  getStreamLogs(id, limit = 100) {
    const stream = this.streams.get(id);
    if (!stream) return [];
    return stream.logs.slice(-limit);
  }
}

module.exports = StreamManager;
