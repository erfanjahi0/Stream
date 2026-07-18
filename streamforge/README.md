# 📡 StreamForge

### Stream Google Drive videos to YouTube Live via RTMP — built for Railway.com

StreamForge is a self-hosted web application that takes a **public Google Drive video link**, downloads it (handling large files 3–5GB+), and live streams it to **YouTube** (or any RTMP destination) using FFmpeg. It features a polished real-time dashboard with live FFmpeg stats, download progress, and multi-stream support.

---

## ✨ Features

| Feature | Details |
|---|---|
| **Google Drive Integration** | Paste any public Drive link — automatically extracts file ID, handles virus-scan confirmation for large files |
| **Large File Support** | Streaming download with progress tracking — handles 3GB, 5GB+ files without loading into memory |
| **RTMP Streaming** | FFmpeg-powered encoding with `-re` flag for proper live-stream pacing |
| **Real-Time Dashboard** | WebSocket-based live stats: FPS, bitrate, speed, frame count, dropped frames, uptime |
| **Multi-Stream** | Run up to 3 concurrent streams (configurable) |
| **Loop Mode** | 24/7 streaming with `-stream_loop -1` |
| **Quality Control** | Choose resolution (1080p/720p/480p/360p/original), bitrate, and FPS |
| **FFmpeg Logs** | Live FFmpeg stderr output in the UI for debugging |
| **Dark UI** | Modern, responsive dark theme with toast notifications |
| **Railway Ready** | Nixpacks config installs ffmpeg automatically — zero manual setup |

---

## 🚀 Quick Deploy to Railway

### Step 1: Clone & Push

```bash
git clone https://github.com/yourusername/streamforge.git
cd streamforge
```

### Step 2: Deploy on Railway

1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
2. Select your StreamForge repository
3. Railway will automatically detect the `nixpacks.toml` and install **ffmpeg + Node.js 20**
4. Add a **persistent volume** (optional but recommended for large files):
   - Go to **Settings** → **Volumes** → **Add Volume**
   - Mount path: `/tmp/streamforge/downloads`
   - Size: 10GB+ (depending on your video sizes)

### Step 3: Set Environment Variables

In Railway → **Variables**, add:

| Variable | Value | Required |
|---|---|---|
| `YOUTUBE_RTMP_URL` | `rtmp://a.rtmp.youtube.com/live2` | No (defaults to YouTube) |
| `YOUTUBE_STREAM_KEY` | Your YouTube stream key | Yes (or enter in UI) |
| `MAX_CONCURRENT_STREAMS` | `3` | No (defaults to 3) |
| `DOWNLOAD_DIR` | `/tmp/streamforge/downloads` | No (defaults to /tmp) |

> **Note:** You can also enter the stream key directly in the web UI each time — it doesn't have to be stored in env vars.

### Step 4: Get Your YouTube Stream Key

1. Go to [YouTube Studio](https://studio.youtube.com)
2. Click **Create** → **Go Live** → **Stream** (not "Manage")
3. Copy the **Stream Key** (not the stream URL)
4. Paste it into the StreamForge UI

### Step 5: Stream!

1. Open your Railway app URL (e.g. `https://streamforge-production.up.railway.app`)
2. Paste your Google Drive video URL
3. Paste your YouTube stream key
4. Click **Start Live Stream**
5. Watch the real-time dashboard as it downloads → encodes → streams

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    StreamForge Architecture                │
│                                                          │
│  ┌─────────┐    ┌──────────────┐    ┌─────────────────┐  │
│  │  Browser │◄──►│  Express +   │◄──►│  Socket.io      │  │
│  │  (UI)   │    │  REST API    │    │  (Real-time)    │  │
│  └─────────┘    └──────┬───────┘    └─────────────────┘  │
│                        │                                 │
│              ┌─────────┴──────────┐                      │
│              │                    │                      │
│     ┌────────▼───────┐  ┌────────▼────────┐              │
│     │ Drive Downloader│  │ Stream Manager  │              │
│     │ (node-fetch +   │  │ (FFmpeg spawn)  │              │
│     │  stream pipe)   │  │                 │              │
│     └────────┬────────┘  └────────┬────────┘              │
│              │                    │                       │
│     ┌────────▼───────┐  ┌────────▼────────┐              │
│     │ Google Drive   │  │ YouTube RTMP    │              │
│     │ (public link)  │  │ (live2 endpoint)│              │
│     └────────────────┘  └─────────────────┘              │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### How It Works

1. **User submits** a Google Drive URL + YouTube stream key via the web UI
2. **Drive Downloader** extracts the file ID, handles Google's large-file confirmation page, and streams the download to disk with real-time progress
3. **Stream Manager** spawns FFmpeg with `-re` (real-time encoding), libx264 + aac, and pushes to the RTMP endpoint
4. **Socket.io** streams live FFmpeg stats (FPS, bitrate, speed, frames) to the browser dashboard
5. **User can stop** the stream at any time — FFmpeg receives SIGTERM for clean shutdown

---

## 📁 Project Structure

```
streamforge/
├── src/
│   ├── server.js           # Express + Socket.io server, REST API
│   ├── driveDownloader.js  # Google Drive file download with large-file support
│   └── streamManager.js    # FFmpeg RTMP stream lifecycle management
├── public/
│   ├── index.html          # Main UI (dark theme dashboard)
│   ├── styles.css          # Modern dark stylesheet
│   └── app.js              # Frontend logic + Socket.io client
├── package.json
├── nixpacks.toml           # Railway: installs ffmpeg + nodejs
├── railway.toml            # Railway: deploy config + volume
├── Procfile                # Alternative deploy (Heroku, etc.)
├── .env.example            # Environment variable template
└── .gitignore
```

---

## ⚙️ FFmpeg Encoding Settings

StreamForge uses optimized settings for YouTube live streaming:

| Setting | Value | Why |
|---|---|---|
| Codec | `libx264` | H.264 — YouTube's recommended codec |
| Preset | `veryfast` | Low CPU usage, good quality balance |
| Pixel Format | `yuv420p` | Maximum compatibility |
| Keyframe Interval | `2s` (fps × 2) | YouTube requires 2-second keyframes |
| Audio Codec | `aac` | Standard audio codec for RTMP |
| Audio Bitrate | `128k` | Good quality stereo |
| Audio Sample Rate | `44100Hz` | Standard |
| `-re` flag | Enabled | Read input at native frame rate (critical for streaming) |
| Output Format | `flv` | RTMP requires FLV container |

---

## 🔧 Local Development

### Prerequisites
- Node.js 18+
- FFmpeg installed (`brew install ffmpeg` / `apt install ffmpeg`)

### Run

```bash
# Install dependencies
npm install

# Copy env file
cp .env.example .env
# Edit .env with your stream key

# Start the server
npm start

# Open http://localhost:3000
```

---

## 🛡️ Important Notes

### Google Drive File Requirements
- The file must be set to **"Anyone with the link can view"**
- For files >100MB, Google shows a virus-scan warning — StreamForge handles this automatically
- Very large files (5GB+) may take significant time to download depending on your Railway plan's bandwidth

### Railway Resource Recommendations
- **Plan:** At least the Developer plan ($5/mo) for sufficient CPU/RAM for FFmpeg encoding
- **Volume:** Add a persistent volume for the download directory if you plan to stream large files repeatedly
- **RAM:** 1080p encoding uses ~1-2GB RAM. 720p uses ~500MB-1GB.

### YouTube Live Requirements
- You need a verified YouTube channel (phone verification)
- Live streaming must be enabled (may take 24h to activate after first request)
- YouTube has encoding guidelines: [Recommended settings](https://support.google.com/youtube/answer/2853702)

### Security
- The stream key is sent directly from the browser to your server — use HTTPS (Railway provides this automatically)
- Stream keys are never logged or stored permanently
- Downloaded files are cleaned up when the stream ends

---

## 📜 API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Health check + stream count |
| `POST` | `/api/preview` | Preview Google Drive file info `{ url }` |
| `POST` | `/api/stream/start` | Start a new stream `{ driveUrl, streamKey, rtmpUrl, resolution, bitrate, fps, loop }` |
| `POST` | `/api/stream/:id/stop` | Stop a running stream |
| `GET` | `/api/streams` | List all active streams |
| `GET` | `/api/stream/:id` | Get stream details + logs |
| `GET` | `/api/stream/:id/logs` | Get FFmpeg logs |

### WebSocket Events

| Event | Direction | Description |
|---|---|---|
| `download:progress` | Server → Client | Download progress (bytes, speed, percent) |
| `download:complete` | Server → Client | Download finished |
| `download:error` | Server → Client | Download failed |
| `stream:started` | Server → Client | Stream has begun |
| `stream:stats` | Server → Client | Live FFmpeg stats update |
| `stream:live` | Server → Client | Stream is now live |
| `stream:ended` | Server → Client | Stream stopped/completed |
| `stream:error` | Server → Client | Stream error |
| `stream:log` | Server → Client | FFmpeg log line |

---

## 📄 License

MIT — Use it, modify it, deploy it.

---

**Built with ❤️ for the creator community.**
