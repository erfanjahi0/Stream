// ═══════════════════════════════════════════════════════════════
//  StreamForge — Frontend v3
//  Fixed streaming, file management, working controls
// ═══════════════════════════════════════════════════════════════

const socket = io();
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

let currentDownloadId = null;
let activeStreamIds = new Set();
let currentSource = 'drive';

// ═══════════════════════════════════════════════════════════════
//  TABS
// ═══════════════════════════════════════════════════════════════

$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    $$('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    $(`#tab-${tab.dataset.tab}`).classList.add('active');
    if (tab.dataset.tab === 'files') fetchFiles();
  });
});

// ═══════════════════════════════════════════════════════════════
//  SOURCE TOGGLE (Drive vs Existing File)
// ═══════════════════════════════════════════════════════════════

$$('.source-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.source-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentSource = btn.dataset.source;
    $('#driveSource').style.display = currentSource === 'drive' ? 'flex' : 'none';
    $('#fileSource').style.display = currentSource === 'file' ? 'flex' : 'none';
    if (currentSource === 'file') refreshFileSelect();
  });
});

// ═══════════════════════════════════════════════════════════════
//  SOCKET EVENTS
// ═══════════════════════════════════════════════════════════════

socket.on('connect', () => {
  const pill = $('#serverStatus');
  pill.classList.add('connected');
  pill.querySelector('.status-text').textContent = 'Connected';
});

socket.on('disconnect', () => {
  const pill = $('#serverStatus');
  pill.classList.remove('connected');
  pill.querySelector('.status-text').textContent = 'Disconnected';
});

socket.on('download:progress', (data) => {
  if (data.downloadId !== currentDownloadId) return;
  const percent = data.percent || 0;
  $('#dlPercent').textContent = `${percent.toFixed(1)}%`;
  $('#dlProgressBar').style.width = `${percent}%`;
  if (data.speed) $('#dlSpeed').textContent = formatSpeed(data.speed);
  const dlMB = (data.downloaded / 1048576).toFixed(1);
  const totMB = data.total ? (data.total / 1048576).toFixed(1) : '?';
  $('#dlSize').textContent = `${dlMB} MB / ${totMB} MB`;
});

socket.on('download:complete', (data) => {
  if (data.downloadId !== currentDownloadId) return;
  $('#dlPercent').textContent = '100%';
  $('#dlProgressBar').style.width = '100%';
  setTimeout(() => { $('#downloadProgress').style.display = 'none'; }, 1500);
  showToast(`Download complete: ${data.name}`, 'success');
  refreshFileSelect();
  fetchFiles();
});

socket.on('download:error', (data) => {
  if (data.downloadId !== currentDownloadId) return;
  $('#downloadProgress').style.display = 'none';
  showToast(`Download failed: ${data.error}`, 'error');
  resetStartBtn();
});

socket.on('stream:started', (data) => {
  currentDownloadId = null;
  resetStartBtn();
  showToast(`Stream started: ${data.fileName}`, 'success');
  fetchStreams();
});

socket.on('stream:stats', (data) => updateStreamCard(data.id, data.stats, data.uptime));

socket.on('stream:live', (data) => {
  const card = document.querySelector(`.stream-card[data-stream-id="${data.id}"]`);
  if (card) {
    card.classList.add('status-live');
    card.querySelector('.stream-status-badge').setAttribute('data-status', 'live');
    card.querySelector('.stream-status-text').textContent = 'LIVE';
  }
  showToast('Stream is LIVE!', 'success');
});

socket.on('stream:stopping', (data) => {
  const card = document.querySelector(`.stream-card[data-stream-id="${data.id}"]`);
  if (card) {
    card.querySelector('.stream-status-badge').setAttribute('data-status', 'stopping');
    card.querySelector('.stream-status-text').textContent = 'Stopping…';
  }
});

socket.on('stream:ended', (data) => {
  const card = document.querySelector(`.stream-card[data-stream-id="${data.id}"]`);
  if (card) {
    card.classList.remove('status-live');
    card.querySelector('.stream-status-badge').setAttribute('data-status', data.status);
    const statusText = data.status === 'completed' ? 'Completed' : data.status === 'error' ? 'Error' : 'Stopped';
    card.querySelector('.stream-status-text').textContent = statusText;
    card.querySelector('.stream-stop-btn').textContent = '✓ Done';
    card.querySelector('.stream-stop-btn').disabled = true;
  }
  if (data.diagnosis) {
    showToast(data.diagnosis, 'error', 12000);
  } else {
    showToast(`Stream ${data.status}`, 'info');
  }
  fetchStreams();
  fetchFiles();
});

socket.on('stream:error', (data) => {
  showToast(`Stream error: ${data.error}`, 'error');
  const card = document.querySelector(`.stream-card[data-stream-id="${data.id}"]`);
  if (card) {
    card.querySelector('.stream-status-badge').setAttribute('data-status', 'error');
    card.querySelector('.stream-status-text').textContent = 'Error';
  }
});

socket.on('stream:deleted', (data) => {
  const card = document.querySelector(`.stream-card[data-stream-id="${data.id}"]`);
  if (card) card.remove();
  activeStreamIds.delete(data.id);
  fetchStreams();
});

socket.on('stream:log', (data) => {
  const card = document.querySelector(`.stream-card[data-stream-id="${data.id}"]`);
  if (card) {
    const pre = card.querySelector('.logs-content pre');
    if (pre) {
      pre.textContent += `\n${data.text}`;
      pre.parentElement.scrollTop = pre.parentElement.scrollHeight;
    }
  }
});

socket.on('files:changed', () => {
  refreshFileSelect();
  fetchFiles();
});

// ═══════════════════════════════════════════════════════════════
//  FORM HANDLERS
// ═══════════════════════════════════════════════════════════════

$('#keyToggle').addEventListener('click', () => {
  const inp = $('#streamKey');
  inp.type = inp.type === 'password' ? 'text' : 'password';
});

$('#advancedToggle').addEventListener('click', () => {
  const isOpen = $('#advancedSettings').style.display !== 'none';
  $('#advancedSettings').style.display = isOpen ? 'none' : 'block';
  $('#advancedToggle').classList.toggle('open', !isOpen);
});

$('#shortsMode').addEventListener('change', (e) => {
  $('#shortsFitGroup').style.display = e.target.checked ? 'flex' : 'none';
});

// Preview
$('#previewBtn').addEventListener('click', async () => {
  const url = $('#driveUrl').value.trim();
  if (!url) return showToast('Enter a Google Drive URL first', 'warning');
  $('#previewBtn').disabled = true;
  $('#previewBtn').textContent = 'Fetching…';
  try {
    const res = await fetch('/api/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    const data = await res.json();
    if (data.success) {
      $('#previewName').textContent = data.name;
      $('#previewSize').textContent = data.sizeFormatted;
      $('#previewType').textContent = data.mime;
      $('#previewResult').style.display = 'block';
      showToast('File info retrieved', 'success');
    } else {
      showToast(data.error || 'Failed', 'error');
    }
  } catch (err) { showToast(err.message, 'error'); }
  finally { $('#previewBtn').disabled = false; $('#previewBtn').textContent = '🔍 Preview File'; }
});

// Download only
$('#downloadOnlyBtn').addEventListener('click', async () => {
  const url = $('#driveUrl').value.trim();
  if (!url) return showToast('Enter a Google Drive URL first', 'warning');
  try {
    const res = await fetch('/api/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ driveUrl: url }) });
    const data = await res.json();
    if (data.success) {
      currentDownloadId = data.downloadId;
      $('#downloadProgress').style.display = 'block';
      $('#dlPercent').textContent = '0%';
      $('#dlProgressBar').style.width = '0%';
      showToast('Download started', 'info');
    } else { showToast(data.error, 'error'); }
  } catch (err) { showToast(err.message, 'error'); }
});

// Refresh file select dropdown
$('#refreshFilesBtn').addEventListener('click', refreshFileSelect);

// Start stream
$('#streamForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const streamKey = $('#streamKey').value.trim();
  const rtmpUrl = $('#rtmpUrl').value.trim();
  const resolution = $('#resolution').value;
  const bitrate = $('#bitrate').value;
  const fps = parseInt($('#fps').value);
  const loop = $('#loop').checked;
  const shortsMode = $('#shortsMode').checked;
  const shortsFit = $('#shortsFit').value;

  if (!streamKey) return showToast('Stream key is required', 'warning');

  const startBtn = $('#startBtn');
  startBtn.disabled = true;
  startBtn.innerHTML = '<div class="spinner"></div> Starting…';

  try {
    let res, data;

    if (currentSource === 'drive') {
      const driveUrl = $('#driveUrl').value.trim();
      if (!driveUrl) { showToast('Google Drive URL is required', 'warning'); resetStartBtn(); return; }

      res = await fetch('/api/stream/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ driveUrl, streamKey, rtmpUrl, resolution, bitrate, fps, loop, shortsMode, shortsFit }),
      });
      data = await res.json();

      if (data.success) {
        currentDownloadId = data.downloadId;
        $('#downloadProgress').style.display = 'block';
        $('#dlPercent').textContent = '0%';
        $('#dlProgressBar').style.width = '0%';
        $('#dlSpeed').textContent = 'Connecting…';
        $('#dlSize').textContent = '0 MB / 0 MB';
        showToast('Download started — stream will begin when ready', 'info');
      } else { showToast(data.error, 'error'); resetStartBtn(); }

    } else {
      // Existing file
      const fileName = $('#fileSelect').value;
      if (!fileName) { showToast('Select a file first', 'warning'); resetStartBtn(); return; }

      res = await fetch('/api/stream/file', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName, streamKey, rtmpUrl, resolution, bitrate, fps, loop, shortsMode, shortsFit }),
      });
      data = await res.json();

      if (data.success) {
        showToast(`Streaming: ${data.fileName}`, 'success');
        resetStartBtn();
        fetchStreams();
      } else { showToast(data.error, 'error'); resetStartBtn(); }
    }
  } catch (err) { showToast(err.message, 'error'); resetStartBtn(); }
});

// ═══════════════════════════════════════════════════════════════
//  STREAM CARDS
// ═══════════════════════════════════════════════════════════════

async function fetchStreams() {
  try {
    const res = await fetch('/api/streams');
    const data = await res.json();
    renderStreams(data.streams);
    $('#streamCount').textContent = `${data.streams.length} / 3 streams`;
  } catch (err) { console.error(err); }
}

function renderStreams(streams) {
  const empty = $('#emptyState');
  if (streams.length === 0) {
    empty.style.display = 'flex';
    $$('.stream-card').forEach(c => c.remove());
    activeStreamIds.clear();
    return;
  }
  empty.style.display = 'none';

  streams.forEach(s => {
    if (!activeStreamIds.has(s.id)) {
      createStreamCard(s);
      activeStreamIds.add(s.id);
    }
    updateStreamCard(s.id, s.stats, s.uptimeSeconds);
    updateStreamStatus(s.id, s.status);
  });

  $$('.stream-card').forEach(card => {
    const id = card.dataset.streamId;
    if (!streams.find(s => s.id === id)) { card.remove(); activeStreamIds.delete(id); }
  });
}

function createStreamCard(stream) {
  const tpl = $('#streamCardTemplate');
  const card = tpl.content.cloneNode(true).querySelector('.stream-card');
  card.setAttribute('data-stream-id', stream.id);
  card.querySelector('.stream-filename').textContent = stream.fileName;

  const configDiv = card.querySelector('.stream-card-config');
  const addTag = (text, style) => {
    const tag = document.createElement('span');
    tag.className = 'config-tag';
    if (style) tag.style.cssText = style;
    tag.textContent = text;
    configDiv.appendChild(tag);
  };
  addTag(stream.resolution);
  addTag(stream.bitrate);
  addTag(`${stream.fps}fps`);
  addTag(stream.loop ? 'LOOP' : 'NO LOOP', stream.loop ? '' : 'opacity:0.4');
  if (stream.shortsMode) addTag('📱 SHORTS 9:16', 'background:rgba(255,0,80,0.15);border-color:rgba(255,0,80,0.4);color:#ff0050;');

  card.querySelector('.stream-stop-btn').addEventListener('click', () => stopStream(stream.id));
  card.querySelector('.stream-delete-btn').addEventListener('click', () => deleteStream(stream.id));
  card.querySelector('.logs-toggle').addEventListener('click', () => {
    const c = card.querySelector('.logs-content');
    c.style.display = c.style.display === 'none' ? 'block' : 'none';
  });

  socket.emit('stream:subscribe', stream.id);
  $('#streamsList').appendChild(card);
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

function updateStreamStatus(id, status) {
  const card = document.querySelector(`.stream-card[data-stream-id="${id}"]`);
  if (!card) return;
  const badge = card.querySelector('.stream-status-badge');
  badge.setAttribute('data-status', status);
  card.querySelector('.stream-status-text').textContent = capitalize(status);
  card.classList.toggle('status-live', status === 'live');

  const stopBtn = card.querySelector('.stream-stop-btn');
  if (status === 'completed' || status === 'stopped' || status === 'error') {
    stopBtn.textContent = '✓ Done';
    stopBtn.disabled = true;
  }
}

async function stopStream(id) {
  try {
    const res = await fetch(`/api/stream/${id}/stop`, { method: 'POST' });
    const data = await res.json();
    if (data.success) showToast('Stream stopping…', 'info');
    else showToast(data.error, 'error');
  } catch (err) { showToast(err.message, 'error'); }
}

async function deleteStream(id) {
  try {
    const res = await fetch(`/api/stream/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) { showToast('Stream deleted', 'info'); fetchStreams(); }
    else showToast(data.error, 'error');
  } catch (err) { showToast(err.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════
//  FILE MANAGEMENT
// ═══════════════════════════════════════════════════════════════

async function refreshFileSelect() {
  try {
    const res = await fetch('/api/files');
    const data = await res.json();
    const select = $('#fileSelect');
    if (data.files.length === 0) {
      select.innerHTML = '<option value="">No files available — download one first</option>';
    } else {
      select.innerHTML = '<option value="">Select a file…</option>';
      data.files.forEach(f => {
        const opt = document.createElement('option');
        opt.value = f.name;
        opt.textContent = `${f.name} (${f.sizeFormatted})`;
        select.appendChild(opt);
      });
    }
  } catch (err) { console.error(err); }
}

async function fetchFiles() {
  try {
    const res = await fetch('/api/files');
    const data = await res.json();
    renderFiles(data.files);
  } catch (err) { console.error(err); }
}

function renderFiles(files) {
  const list = $('#filesList');
  list.innerHTML = '';

  if (files.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div><h3>No downloaded files</h3><p>Download a file from Google Drive first</p></div>`;
    return;
  }

  files.forEach(f => {
    const tpl = $('#fileRowTemplate');
    const row = tpl.content.cloneNode(true).querySelector('.file-row');
    row.querySelector('.file-name').textContent = f.name;
    row.querySelector('.file-meta').textContent = `${f.sizeFormatted} · ${new Date(f.modified).toLocaleString()}`;
    row.querySelector('.file-stream-btn').addEventListener('click', () => streamFromFile(f.name));
    row.querySelector('.file-delete-btn').addEventListener('click', () => deleteFile(f.name));
    list.appendChild(row);
  });
}

async function streamFromFile(fileName) {
  // Switch to stream tab and select the file
  $$('.tab').forEach(t => t.classList.remove('active'));
  $$('.tab-content').forEach(c => c.classList.remove('active'));
  $$('.tab')[0].classList.add('active');
  $('#tab-stream').classList.add('active');

  // Switch to file source
  $$('.source-btn').forEach(b => b.classList.remove('active'));
  $$('.source-btn')[1].classList.add('active');
  currentSource = 'file';
  $('#driveSource').style.display = 'none';
  $('#fileSource').style.display = 'flex';
  await refreshFileSelect();
  $('#fileSelect').value = fileName;
  showToast(`Selected: ${fileName}. Enter stream key and click Start.`, 'info');
}

async function deleteFile(fileName) {
  if (!confirm(`Delete ${fileName}?`)) return;
  try {
    const res = await fetch(`/api/files/${encodeURIComponent(fileName)}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) { showToast(`Deleted: ${fileName}`, 'info'); fetchFiles(); refreshFileSelect(); }
    else showToast(data.error, 'error');
  } catch (err) { showToast(err.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════

function resetStartBtn() {
  const btn = $('#startBtn');
  btn.disabled = false;
  btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8" fill="currentColor"/></svg> Start Live Stream`;
}

function formatDuration(sec) {
  if (!sec || sec < 0) return '00:00:00';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function formatSpeed(bps) {
  if (bps >= 1048576) return `${(bps/1048576).toFixed(1)} MB/s`;
  if (bps >= 1024) return `${(bps/1024).toFixed(0)} KB/s`;
  return `${bps.toFixed(0)} B/s`;
}

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : '—'; }

function showToast(msg, type = 'info', duration = 5000) {
  const icons = { success: '✓', error: '✕', info: 'ℹ', warning: '⚠' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${icons[type]||'ℹ'}</span><span>${msg}</span>`;
  $('#toastContainer').appendChild(toast);
  setTimeout(() => { toast.style.animation = 'toastIn 0.3s ease reverse'; setTimeout(() => toast.remove(), 300); }, duration);
}

// ═══════════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════════

fetchStreams();
refreshFileSelect();
setInterval(fetchStreams, 5000);
