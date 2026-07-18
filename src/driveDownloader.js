// ═══════════════════════════════════════════════════════════════
//  StreamForge — Google Drive Downloader v2
//  Robust large-file download with virus-scan bypass
//  Uses drive.usercontent.google.com endpoint (reliable for 5GB+)
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { createWriteStream } = require('fs');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

// Increase max sockets for large file downloads
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 10,
  maxFreeSockets: 5,
  timeout: 0,
});

/**
 * Extract the file ID from a Google Drive public link.
 */
function extractFileId(url) {
  if (!url) throw new Error('No URL provided');

  const trimmed = url.trim();

  // Already a raw ID
  if (/^[a-zA-Z0-9_-]{20,50}$/.test(trimmed)) {
    return trimmed;
  }

  const patterns = [
    /\/file\/d\/([a-zA-Z0-9_-]+)/,
    /\/d\/([a-zA-Z0-9_-]+)/,
    /[?&]id=([a-zA-Z0-9_-]+)/,
    /uc\?export=download&id=([a-zA-Z0-9_-]+)/,
    /usercontent\.google\.com\/download\?id=([a-zA-Z0-9_-]+)/,
  ];

  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }

  throw new Error(`Could not extract file ID from: ${url}`);
}

/**
 * Lightweight fetch wrapper with redirect following and timeout.
 */
function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const maxRedirects = options.maxRedirects || 10;
    let redirectCount = 0;
    let currentUrl = url;

    const doRequest = (reqUrl) => {
      const lib = reqUrl.startsWith('https') ? https : http;
      const urlObj = new URL(reqUrl);

      const reqOptions = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: options.method || 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': '*/*',
          ...options.headers,
        },
        agent: httpsAgent,
        timeout: options.timeout || 0,
      };

      const req = lib.request(reqOptions, (res) => {
        // Handle redirects
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (redirectCount >= maxRedirects) {
            reject(new Error(`Too many redirects (max ${maxRedirects})`));
            return;
          }
          redirectCount++;
          const nextUrl = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, reqUrl).href;
          res.resume(); // drain
          doRequest(nextUrl);
          return;
        }

        resolve(res);
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error('Request timeout'));
      });

      if (options.body) {
        req.write(options.body);
      }
      req.end();
    };

    doRequest(currentUrl);
  });
}

/**
 * Collect response body as text (for parsing HTML confirmation pages).
 */
function collectBody(res, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    res.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        res.destroy();
        reject(new Error('Response too large for HTML parsing'));
        return;
      }
      data += chunk.toString();
    });
    res.on('end', () => resolve(data));
    res.on('error', reject);
  });
}

/**
 * Fetch file metadata from Google Drive.
 * Parses the public view page for filename and size.
 */
async function getFileInfo(fileId) {
  const metaUrl = `https://drive.google.com/file/d/${fileId}/view`;

  try {
    const res = await fetchUrl(metaUrl, { timeout: 15000 });
    const html = await collectBody(res);

    // Extract filename from page title
    let name = 'video.mp4';
    const titleMatch = html.match(/<title>(.*?)<\/title>/i);
    if (titleMatch) {
      const raw = titleMatch[1].replace(/\s*-\s*Google Drive\s*$/i, '').trim();
      if (raw && raw !== 'Google Drive - File not found') name = raw;
    }

    // Try to extract file size from the page
    let size = null;
    const sizeMatch = html.match(/(\d+(?:[.,]\d+)?)\s*(KB|MB|GB|TB)/i);
    if (sizeMatch) {
      const num = parseFloat(sizeMatch[1].replace(',', '.'));
      const unit = sizeMatch[2].toUpperCase();
      const multipliers = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
      size = num * (multipliers[unit] || 1);
    }

    // Extract mime type
    let mime = 'video/mp4';
    const mimeMatch = html.match(/"mimeType":"([^"]+)"/);
    if (mimeMatch) mime = mimeMatch[1];

    // Check if file is accessible
    if (html.includes('File not found') || html.includes('Sorry, the file you have requested does not exist')) {
      throw new Error('Google Drive file not found. Make sure the sharing setting is "Anyone with the link can view".');
    }

    return { id: fileId, name, size, mime };
  } catch (err) {
    if (err.message.includes('not found')) throw err;
    // If metadata fetch fails, return defaults — download may still work
    return { id: fileId, name: `drive_${fileId}.mp4`, size: null, mime: 'video/mp4' };
  }
}

/**
 * Download a Google Drive file with robust large-file virus-scan bypass.
 *
 * Strategy:
 * 1. Try drive.usercontent.google.com with confirm=t (bypasses warning in most cases)
 * 2. If that returns HTML, parse the form for the actual download URL + params
 * 3. Follow the real download URL with streaming to disk
 *
 * @param {string} fileId     - Google Drive file ID
 * @param {string} destDir    - Directory to save the file
 * @param {function} onProgress - callback({ downloaded, total, speed, percent, fileName })
 * @returns {Promise<{path, size, name}>}
 */
async function downloadFile(fileId, destDir, onProgress) {
  const info = await getFileInfo(fileId);
  const fileName = sanitizeFilename(info.name || `drive_${fileId}.mp4`);
  const finalPath = path.join(destDir, fileName);

  console.log(`[DriveDL] Starting download: ${fileId} → ${fileName}`);

  // ─── Step 1: Try direct download with confirm=t ───
  // The drive.usercontent.google.com endpoint is more reliable than uc?export=download
  // Adding confirm=t bypasses the virus scan warning for most files
  let downloadUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;

  let res = await fetchUrl(downloadUrl, { timeout: 30000 });

  // Check if we got an HTML page (virus scan warning) instead of the file
  const contentType = res.headers['content-type'] || '';
  const contentDisp = res.headers['content-disposition'] || '';

  // If we got the actual file (not HTML), stream it directly
  if (contentType.includes('application/octet-stream') ||
      contentType.includes('video/') ||
      contentDisp.includes('attachment') ||
      (contentType.includes('text/html') === false && res.statusCode === 200)) {
    console.log('[DriveDL] Direct download succeeded (confirm=t bypass worked)');
    return await streamToFile(res, finalPath, info.size, fileName, onProgress);
  }

  // ─── Step 2: We got HTML — parse the confirmation form ───
  console.log('[DriveDL] Got HTML page, parsing for download form...');

  // Don't consume the whole body if it's huge — but HTML pages are small
  let html = '';
  try {
    html = await collectBody(res, 2 * 1024 * 1024); // 2MB max for HTML
  } catch (e) {
    // If it's not HTML but we're here, maybe it's the file after all
    console.log('[DriveDL] Body collection failed, treating as direct download');
  }

  // Parse the HTML form for the actual download URL
  // Google's confirmation page has a form with action URL and hidden inputs
  const formMatch = html.match(/<form[^>]*action="([^"]+)"[^>]*method="post"/i);
  const formInputs = {};
  const inputRegex = /<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gi;
  let inputMatch;
  while ((inputMatch = inputRegex.exec(html)) !== null) {
    formInputs[inputMatch[1]] = inputMatch[2];
  }

  // Also try to extract from JavaScript-based download URL
  const jsUrlMatch = html.match(/https:\/\/drive\.usercontent\.google\.com\/download\?[^"'\s]+/);
  const jsDownloadMatch = html.match(/["']download["']\s*:\s*["']([^"']+)["']/);

  // Build the real download URL
  if (formMatch) {
    // Use the form action URL
    let formAction = formMatch[1];
    if (formAction.startsWith('/')) {
      formAction = `https://drive.google.com${formAction}`;
    }
    // Add hidden form fields as query params
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(formInputs)) {
      params.set(key, value);
    }
    downloadUrl = formAction.includes('?')
      ? `${formAction}&${params.toString()}`
      : `${formAction}?${params.toString()}`;
    console.log(`[DriveDL] Using form action URL with ${Object.keys(formInputs).length} params`);
  } else if (jsUrlMatch) {
    downloadUrl = jsUrlMatch[0].replace(/&amp;/g, '&');
    console.log('[DriveDL] Using JS download URL');
  } else {
    // Fallback: try with uuid parameter extracted from page
    const uuidMatch = html.match(/uuid=([a-zA-Z0-9_-]+)/);
    const confirmMatch = html.match(/confirm=([a-zA-Z0-9_]+)/);

    const params = new URLSearchParams();
    params.set('id', fileId);
    params.set('export', 'download');
    params.set('confirm', confirmMatch ? confirmMatch[1] : 't');
    if (uuidMatch) params.set('uuid', uuidMatch[1]);

    downloadUrl = `https://drive.usercontent.google.com/download?${params.toString()}`;
    console.log('[DriveDL] Using fallback URL with extracted params');
  }

  // ─── Step 3: Download the actual file ───
  res = await fetchUrl(downloadUrl, { timeout: 0 }); // No timeout for large files

  // Verify we got the file this time
  const finalContentType = res.headers['content-type'] || '';
  const finalContentDisp = res.headers['content-disposition'] || '';

  if (res.statusCode !== 200) {
    throw new Error(`Download failed: HTTP ${res.statusCode}`);
  }

  // If we still got HTML, the file might be restricted
  if (finalContentType.includes('text/html') && !finalContentDisp.includes('attachment')) {
    const errorBody = await collectBody(res, 100000);
    if (errorBody.includes('quota') || errorBody.includes('exceeded')) {
      throw new Error('Google Drive download quota exceeded for this file. Try again later or use a different file.');
    }
    if (errorBody.includes('sign in') || errorBody.includes('login')) {
      throw new Error('This Google Drive file requires sign-in. Make sure it is set to "Anyone with the link can view".');
    }
    throw new Error('Could not bypass Google Drive virus scan page. The file may be restricted or temporarily unavailable.');
  }

  console.log('[DriveDL] Real file download started');
  return await streamToFile(res, finalPath, info.size, fileName, onProgress);
}

/**
 * Stream an HTTP response to a file with progress tracking.
 */
async function streamToFile(res, filePath, expectedSize, fileName, onProgress) {
  const contentLength = parseInt(res.headers['content-length'] || expectedSize || '0', 10);
  const fileStream = createWriteStream(filePath);
  let downloaded = 0;
  const startTime = Date.now();
  let lastProgressTime = 0;

  const progressStream = new Transform({
    transform(chunk, encoding, callback) {
      downloaded += chunk.length;
      const now = Date.now();

      // Throttle progress updates to every 500ms
      if (onProgress && (now - lastProgressTime > 500 || downloaded === contentLength)) {
        lastProgressTime = now;
        const elapsedSec = (now - startTime) / 1000;
        const speed = elapsedSec > 0 ? downloaded / elapsedSec : 0;

        onProgress({
          downloaded,
          total: contentLength,
          speed,
          percent: contentLength > 0 ? (downloaded / contentLength) * 100 : 0,
          fileName,
        });
      }

      callback(null, chunk);
    },
  });

  await pipeline(res, progressStream, fileStream);

  const stat = fs.statSync(filePath);
  console.log(`[DriveDL] Download complete: ${filePath} (${formatBytes(stat.size)})`);

  // Final progress callback
  if (onProgress) {
    onProgress({
      downloaded: stat.size,
      total: stat.size,
      speed: 0,
      percent: 100,
      fileName,
    });
  }

  return {
    path: filePath,
    size: stat.size,
    name: fileName,
  };
}

/**
 * Sanitize a filename for safe filesystem use.
 */
function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 200);
}

/**
 * Format bytes to human-readable string.
 */
function formatBytes(bytes) {
  if (!bytes) return 'Unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(2)} ${units[i]}`;
}

module.exports = { extractFileId, getFileInfo, downloadFile, formatBytes };
