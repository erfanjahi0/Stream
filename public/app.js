// ═══════════════════════════════════════════════════════════════
//  StreamForge — Frontend Application
//  Real-time UI with Socket.io for stream monitoring
// ═══════════════════════════════════════════════════════════════

// ─── Socket.io connection ───
const socket = io();

// ─── DOM Elements ───
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const streamForm = $('#streamForm');
const startBtn = $('#startBtn');
const previewBtn = $('#previewBtn');
const previewResult = $('#previewResult');
const keyToggle = $('#keyToggle');
const advancedToggle = $('#advancedToggle');
const advancedSettings = $('#advancedSettings');
const downloadProgress = $('#downloadProgress');
const streamsList = $('#streamsList');
const emptyState = $('#emptyState');
const toastContainer = $('#toastContainer');

// ─── State ───
let currentDownloadId = null;
let activeStreamIds = new Set();

// ═══════════════════════════════════════════════════════════════
//  SOCKET.IO EVENTS
// ═══════════════════════════════════════════════════════════════

socket.on('connect', () => {
  const pill = $('#serverStatus');
  pill.classList.add('connected');
  pill.querySelector('.status-text').textContent = 'Connected';
  showToast('Connected to server', 'success');
});

socket.on('disconnect', () => {
  const pill = $('#serverStatus');
  pill.classList.remove('connected');
  pill.querySelector('.status-text').textContent = 'Disconnected';
  showToast('Disconnected from server', 'error');
});

// Download progress
socket.on('download:progress', (data) => {
  if (data.downloadId !== currentDownloadId) return;

  const percent = data.percent || 0;
  $('#dlPercent').textContent = `${percent.toFixed(1)}%`;
  $('#dlProgressBar').style.width = `${percent}%`;

  if (data.speed) {
    $('#dlSpeed').textContent = `${formatSpeed(data.speed)}`;
  }

  const downloadedMB = (data.downloaded / 1024 / 1024).toFixed(1);
  const totalMB = data.total ? (data.total / 1024 / 1024).toFixed(1) : '?';
  $('#dlSize').textContent = `${downloadedMB} MB / ${totalMB} MB`;
});

socket.on('download:complete', (data) => {
  if (data.downloadId !== currentDownloadId) return;

  $('#dlPercent').textContent = '100%';
  $('#dlProgressBar').style.width = '100%';
  $('#dlSpeed').textContent = 'Download complete';

  setTimeout(() => {
    downloadProgress.style.display = 'none';
  }, 2000);

  showToast(`Download complete: ${data.name}`, 'success');
});

socket.on('download:error', (data) => {
  if (data.downloadId !== currentDownloadId) return;
  downloadProgress.style.display = 'none';
  showToast(`Download failed: ${data.error}`, 'error');
  startBtn.disabled = false;
  startBtn.innerHTML = getStartBtnContent();
});

// Stream events
socket.on('stream:started', (data) => {
  currentDownloadId = null;
  startBtn.disabled = false;
  startBtn.innerHTML = getStartBtnContent();
  showToast(`Stream started: ${data.fileName}`, 'success');
  fetchStreams();
});

socket.on('stream:stats', (data) => {
  updateStreamCard(data.id, data.stats, data.uptime);
});

socket.on('stream:live', (data) => {
  const card = document.querySelector(`.stream-card[data-stream-id="${data.id}"]`);
  if (card) {
    card.classList.add('status-live');
    const badge = card.querySelector('.stream-status-badge');
    badge.setAttribute('data-status', 'live');
    card.querySelector('.stream-status-text').textContent = 'LIVE';
  }
  showToast('Stream is LIVE on YouTube!', 'success');
});

socket.on('stream:ended', (data) => {
  const card = document.querySelector(`.stream-card[data-stream-id="${data.id}"]`);
  if (card) {
    card.classList.remove('status-live');
    const badge = card.querySelector('.stream-status-badge');
    badge.setAttribute('data-status', data.status);
    card.querySelector('.stream-status-text').textContent =
      data.status === 'completed' ? 'Completed' : 'Stopped';
  }
  showToast(`Stream ${data.status} (uptime: ${formatDuration(data.uptime)})`, 'info');
  fetchStreams();
});

socket.on('stream:error', (data) => {
  showToast(`Stream error: ${data.error}`, 'error');
});

socket.on('stream:log', (data) => {
  const card = document.querySelector(`.stream-card[data-stream-id="${data.id}"]`);
  if (card) {
    const logsContent = card.querySelector('.logs-content pre');
    if (logsContent) {
      logsContent.textContent += `\n[${new Date().toLocaleTimeString()}] ${data.text}`;
      logsContent.parentElement.scrollTop = logsContent.parentElement.scrollHeight;
    }
  }
});

// ═══════════════════════════════════════════════════════════════
//  FORM HANDLERS
// ═══════════════════════════════════════════════════════════════

// Stream key show/hide
keyToggle.addEventListener('click', () => {
  const input = $('#streamKey');
  input.type = input.type === 'password' ? 'text' : 'password';
});

// Advanced settings toggle
advancedToggle.addEventListener('click', () => {
  const isOpen = advancedSettings.style.display !== 'none';
  advancedSettings.style.display = isOpen ? 'none' : 'block';
  advancedToggle.classList.toggle('open', !isOpen);
});

// Preview file info
previewBtn.addEventListener('click', async () => {
  const url = $('#driveUrl').value.trim();
  if (!url) {
    showToast('Enter a Google Drive URL first', 'warning');
    return;
  }

  previewBtn.disabled = true;
  previewBtn.textContent = 'Fetching…';

  try {
    const res = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();

    if (data.success) {
      $('#previewName').textContent = data.name;
      $('#previewSize').textContent = data.sizeFormatted;
      $('#previewType').textContent = data.mime;
      previewResult.style.display = 'block';
      showToast('File info retrieved', 'success');
    } else {
      showToast(data.error || 'Failed to get file info', 'error');
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  } finally {
    previewBtn.disabled = false;
    previewBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg> Preview File Info`;
  }
});

// Shorts mode toggle
const shortsModeCheckbox = $('#shortsMode');
const shortsFitGroup = $('#shortsFitGroup');

shortsModeCheckbox.addEventListener('change', () => {
  shortsFitGroup.style.display = shortsModeCheckbox.checked ? 'flex' : 'none';
});

// Start stream
streamForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const driveUrl = $('#driveUrl').value.trim();
  const streamKey = $('#streamKey').value.trim();
  const rtmpUrl = $('#rtmpUrl').value.trim();
  const resolution = $('#resolution').value;
  const bitrate = $('#bitrate').value;
  const fps = parseInt($('#fps').value);
  const loop = $('#loop').checked;
  const shortsMode = $('#shortsMode').checked;
  const shortsFit = $('#shortsFit').value;

  if (!driveUrl || !streamKey) {
    showToast('Google Drive URL and stream key are required', 'warning');
    return;
  }

  startBtn.disabled = true;
  startBtn.innerHTML = '<div class="spinner"></div> Starting…';

  try {
    const res = await fetch('/api/stream/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ driveUrl, streamKey, rtmpUrl, resolution, bitrate, fps, loop, shortsMode, shortsFit }),
    });
    const data = await res.json();

    if (data.success) {
      currentDownloadId = data.downloadId;
      downloadProgress.style.display = 'block';
      $('#dlPercent').textContent = '0%';
      $('#dlProgressBar').style.width = '0%';
      $('#dlSpeed').textContent = 'Connecting…';
      $('#dlSize').textContent = '0 MB / 0 MB';
      showToast('Download started — stream will begin when ready', 'info');
    } else {
      showToast(data.error || 'Failed to start stream', 'error');
      startBtn.disabled = false;
      startBtn.innerHTML = getStartBtnContent();
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
    startBtn.disabled = false;
    startBtn.innerHTML = getStartBtnContent();
  }
});

// ═══════════════════════════════════════════════════════════════
//  STREAM CARD MANAGEMENT
// ═══════════════════════════════════════════════════════════════

async function fetchStreams() {
  try {
    const res = await fetch('/api/streams');
    const data = await res.json();
    renderStreams(data.streams);
    updateStreamCount(data.streams.length);
  } catch (err) {
    console.error('Failed to fetch streams:', err);
  }
}

function renderStreams(streams) {
  if (streams.length === 0) {
    emptyState.style.display = 'flex';
    // Remove all stream cards
    $$('.stream-card').forEach((c) => c.remove());
    activeStreamIds.clear();
    return;
  }

  emptyState.style.display = 'none';

  streams.forEach((stream) => {
    if (!activeStreamIds.has(stream.id)) {
      createStreamCard(stream);
      activeStreamIds.add(stream.id);
    }
    updateStreamCard(stream.id, stream.stats, stream.uptimeSeconds);
  });

  // Remove cards for streams that no longer exist
  $$('.stream-card').forEach((card) => {
    const id = card.getAttribute('data-stream-id');
    if (!streams.find((s) => s.id === id)) {
      card.remove();
      activeStreamIds.delete(id);
    }
  });
}

function createStreamCard(stream) {
  const template = $('#streamCardTemplate');
  const card = template.content.cloneNode(true).querySelector('.stream-card');
  card.setAttribute('data-stream-id', stream.id);

  card.querySelector('.stream-filename').textContent = stream.fileName;

  // Config tags
  card.querySelector('[data-config="resolution"]').textContent = stream.shortsMode ? `Shorts ${stream.resolution}` : stream.resolution;
  card.querySelector('[data-config="bitrate"]').textContent = stream.bitrate;
  card.querySelector('[data-config="fps"]').textContent = `${stream.fps}fps`;
  card.querySelector('[data-config="loop"]').textContent = stream.loop ? 'LOOP' : 'NO LOOP';
  card.querySelector('[data-config="loop"]').style.opacity = stream.loop ? '1' : '0.4';

  // Shorts badge
  if (stream.shortsMode) {
    const shortsTag = document.createElement('span');
    shortsTag.className = 'config-tag';
    shortsTag.style.cssText = 'background: rgba(255,0,80,0.15); border-color: rgba(255,0,80,0.4); color: #ff0050;';
    shortsTag.textContent = '📱 SHORTS 9:16';
    card.querySelector('.stream-card-config').appendChild(shortsTag);
  }

  // Status
  const badge = card.querySelector('.stream-status-badge');
  badge.setAttribute('data-status', stream.status);
  card.querySelector('.stream-status-text').textContent = capitalize(stream.status);
  if (stream.status === 'live') card.classList.add('status-live');

  // Stop button
  card.querySelector('.stream-stop-btn').addEventListener('click', () => stopStream(stream.id));

  // Logs toggle
  card.querySelector('.logs-toggle').addEventListener('click', () => {
    const content = card.querySelector('.logs-content');
    content.style.display = content.style.display === 'none' ? 'block' : 'none';
  });

  // Subscribe to stream updates
  socket.emit('stream:subscribe', stream.id);

  streamsList.appendChild(card);
}

function updateStreamCard(id, stats, uptime) {
  const card = document.querySelector(`.stream-card[data-stream-id="${id}"]`);
  if (!card) return;

  card.querySelector('.stream-fps').textContent = stats.fps?.toFixed(1) || '0';
  card.querySelector('.stream-bitrate').textContent = `${stats.bitrate?.toFixed(0) || 0} kbps`;
  card.querySelector('.stream-speed').textContent = `${stats.speed?.toFixed(2) || '1.00'}x`;
  card.querySelector('.stream-frames').textContent = stats.frame?.toLocaleString() || '0';
  card.querySelector('.stream-dropped').textContent = stats.droppedFrames || '0';
  card.querySelector('.stream-uptime').textContent = formatDuration(uptime);
  card.querySelector('.stream-output').textContent = formatDuration(stats.outTimeMs / 1000);
}

async function stopStream(id) {
  try {
    const res = await fetch(`/api/stream/${id}/stop`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('Stream stopping…', 'info');
    } else {
      showToast(data.error || 'Failed to stop stream', 'error');
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

function updateStreamCount(count) {
  const max = parseInt($('#serverStatus .status-text').textContent) || 3;
  $('#streamCount').textContent = `${count} / 3 streams`;
}

// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════

function formatDuration(seconds) {
  if (!seconds || seconds < 0) return '00:00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatSpeed(bytesPerSec) {
  if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  return `${bytesPerSec.toFixed(0)} B/s`;
}

function capitalize(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : '—';
}

function getStartBtnContent() {
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8" fill="currentColor"/></svg> Start Live Stream`;
}

function showToast(message, type = 'info') {
  const icons = { success: '✓', error: '✕', info: 'ℹ', warning: '⚠' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ'}</span><span>${message}</span>`;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'toastIn 0.3s ease reverse';
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}

// ═══════════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════════

// Fetch streams on load
fetchStreams();

// Poll streams every 5 seconds as backup
setInterval(fetchStreams, 5000);
