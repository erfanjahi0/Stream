// ═══════════════════════════════════════════════════════════════
//  StreamForge — Torrent Downloader
//  Downloads video files from magnet URIs via WebTorrent
// ═══════════════════════════════════════════════════════════════

const path = require('path');
const fs = require('fs');

let WebTorrent = null;
let client = null;

/**
 * Lazy-load and initialize the WebTorrent client.
 * Uses a single shared client across all downloads (DHT, peer connections reused).
 */
function getClient() {
  if (!WebTorrent) {
    WebTorrent = require('webtorrent');
  }
  if (!client) {
    client = new WebTorrent({
      // Speed things up
      maxConns: 100,
      // Trackers help find peers faster
      tracker: {
        announce: [
          'udp://tracker.opentrackr.org:1337/announce',
          'udp://open.tracker.cl:1337/announce',
          'udp://tracker.torrent.eu.org:451/announce',
          'udp://tracker.moeking.me:6969/announce',
          'wss://tracker.btorrent.xyz',
          'wss://tracker.openwebtorrent.com',
        ],
      },
    });

    client.on('error', (err) => {
      console.error('[Torrent] Client error:', err.message);
    });
  }
  return client;
}

/**
 * Validate & normalize a magnet URI or infoHash.
 * Accepts: magnet:?xt=urn:btih:HASH, HASH (40 char hex), or full magnet with params.
 */
function normalizeMagnet(input) {
  if (!input) throw new Error('No magnet link provided');
  const trimmed = input.trim();

  // Full magnet URI
  if (trimmed.startsWith('magnet:')) return trimmed;

  // Raw infohash (40 hex chars or 32 base32)
  if (/^[a-fA-F0-9]{40}$/.test(trimmed) || /^[a-zA-Z2-7]{32}$/.test(trimmed)) {
    return `magnet:?xt=urn:btih:${trimmed}`;
  }

  throw new Error('Invalid magnet URI. Must start with "magnet:?xt=urn:btih:" or be a 40-char infohash.');
}

/**
 * Pick the largest video file from a torrent.
 * Falls back to the largest file if no video is found.
 */
function pickVideoFile(torrent) {
  const videoExts = ['.mp4', '.mkv', '.webm', '.mov', '.avi', '.flv', '.wmv', '.m4v', '.ts'];

  // Sort by size, descending
  const sortedBySize = [...torrent.files].sort((a, b) => b.length - a.length);

  // Prefer the largest video file
  for (const f of sortedBySize) {
    const ext = path.extname(f.name).toLowerCase();
    if (videoExts.includes(ext)) return f;
  }

  // Fallback: largest file overall
  return sortedBySize[0];
}

/**
 * Get metadata for a torrent WITHOUT downloading it.
 * Adds the torrent, waits for metadata, then removes it.
 */
function getTorrentInfo(magnetUri, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const c = getClient();
    const magnet = normalizeMagnet(magnetUri);

    let done = false;
    const timeout = setTimeout(() => {
      if (done) return;
      done = true;
      try { c.remove(magnet); } catch (e) {}
      reject(new Error('Timeout fetching torrent metadata (30s). Check the magnet link.'));
    }, timeoutMs);

    // Check if already added
    const existing = c.get(magnet);
    if (existing && existing.ready) {
      clearTimeout(timeout);
      done = true;
      const video = pickVideoFile(existing);
      resolve({
        name: existing.name,
        infoHash: existing.infoHash,
        totalSize: existing.length,
        files: existing.files.map(f => ({ name: f.name, size: f.length })),
        selectedFile: video ? { name: video.name, size: video.length } : null,
      });
      return;
    }

    c.add(magnet, { path: '/tmp/streamforge/torrent-meta' }, (torrent) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);

      const video = pickVideoFile(torrent);
      const info = {
        name: torrent.name,
        infoHash: torrent.infoHash,
        totalSize: torrent.length,
        files: torrent.files.map(f => ({ name: f.name, size: f.length })),
        selectedFile: video ? { name: video.name, size: video.length } : null,
      };

      // Remove immediately — we only wanted metadata
      c.remove(torrent, { destroyStore: true }, () => {
        resolve(info);
      });
    });
  });
}

/**
 * Download a video file from a magnet URI.
 *
 * @param {string} magnetUri  - Magnet link
 * @param {string} destDir    - Where to save the file
 * @param {function} onProgress - callback({ downloaded, total, speed, percent, fileName, peers })
 * @returns {Promise<{path, size, name}>}
 */
function downloadTorrent(magnetUri, destDir, onProgress) {
  return new Promise((resolve, reject) => {
    const c = getClient();
    const magnet = normalizeMagnet(magnetUri);

    fs.mkdirSync(destDir, { recursive: true });

    console.log(`[Torrent] Adding magnet: ${magnet.substring(0, 80)}...`);

    let addTimeout = setTimeout(() => {
      reject(new Error('Timeout waiting for torrent metadata (60s). No peers found or invalid magnet.'));
    }, 60000);

    const torrent = c.add(magnet, { path: destDir }, (torrent) => {
      clearTimeout(addTimeout);
      console.log(`[Torrent] Metadata loaded: ${torrent.name} (${torrent.files.length} files, ${(torrent.length / 1073741824).toFixed(2)} GB)`);

      // Pick the video file we want
      const videoFile = pickVideoFile(torrent);
      if (!videoFile) {
        return reject(new Error('No video file found in torrent'));
      }

      console.log(`[Torrent] Selected file: ${videoFile.name} (${(videoFile.length / 1073741824).toFixed(2)} GB)`);

      // Deselect other files to avoid wasting disk/bandwidth
      torrent.files.forEach(f => {
        if (f !== videoFile) f.deselect();
      });
      videoFile.select();

      const finalName = sanitizeFilename(videoFile.name);
      const finalPath = path.join(destDir, finalName);

      let lastProgressTime = 0;
      const startTime = Date.now();

      // Progress updates
      const progressHandler = () => {
        const now = Date.now();
        if (now - lastProgressTime < 500) return;
        lastProgressTime = now;

        if (onProgress) {
          onProgress({
            downloaded: videoFile.downloaded,
            total: videoFile.length,
            speed: torrent.downloadSpeed,
            percent: videoFile.progress * 100,
            fileName: videoFile.name,
            peers: torrent.numPeers,
            eta: torrent.timeRemaining, // in milliseconds
          });
        }
      };

      torrent.on('download', progressHandler);

      // Done handler — when the SELECTED file finishes
      const doneHandler = () => {
        console.log(`[Torrent] Download complete: ${videoFile.name}`);

        // The file lives at path.join(destDir, videoFile.path)
        const actualPath = path.join(destDir, videoFile.path);

        // Final progress
        if (onProgress) {
          onProgress({
            downloaded: videoFile.length,
            total: videoFile.length,
            speed: 0,
            percent: 100,
            fileName: videoFile.name,
            peers: torrent.numPeers,
            eta: 0,
          });
        }

        // Copy to flat destination if it's in a subdirectory
        let outPath = actualPath;
        if (videoFile.path !== videoFile.name) {
          const flat = path.join(destDir, sanitizeFilename(videoFile.name));
          try {
            fs.copyFileSync(actualPath, flat);
            outPath = flat;
          } catch (e) {
            console.error('[Torrent] Copy to flat path failed, using nested path:', e.message);
          }
        }

        // Remove torrent from client (keep files on disk)
        torrent.destroy({ destroyStore: false }, () => {
          resolve({
            path: outPath,
            size: videoFile.length,
            name: path.basename(outPath),
          });
        });
      };

      // Check if selected file already done (highly unlikely, but be safe)
      if (videoFile.progress === 1) {
        setImmediate(doneHandler);
        return;
      }

      // Poll for selected-file completion
      const checkInterval = setInterval(() => {
        if (videoFile.progress >= 1) {
          clearInterval(checkInterval);
          doneHandler();
        }
      }, 1000);

      torrent.on('error', (err) => {
        clearInterval(checkInterval);
        console.error('[Torrent] Error:', err.message);
        reject(err);
      });
    });

    torrent.on('error', (err) => {
      clearTimeout(addTimeout);
      console.error('[Torrent] Add error:', err.message);
      reject(err);
    });
  });
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim().substring(0, 200);
}

function formatBytes(bytes) {
  if (!bytes) return 'Unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(2)} ${units[i]}`;
}

module.exports = { normalizeMagnet, getTorrentInfo, downloadTorrent, formatBytes };
