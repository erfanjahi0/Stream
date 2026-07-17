# StreamCast Worker

A lightweight Node.js + FFmpeg worker that receives start/stop commands
from the StreamCast website and pushes an RTMP stream to YouTube Live.

## Deploy to Railway

1. Unzip this archive.
2. Push to a new GitHub repository (or use Railway's GitHub integration).
3. In Railway, create a new project from this repo.
4. Add the following environment variable in Railway:
   - `STREAM_TOKEN` — paste the token generated in your StreamCast dashboard
5. Railway will build the Docker image and deploy automatically.
6. Once deployed, copy the Railway public URL (e.g. https://xxx.up.railway.app).
7. Paste both the URL and your token into the StreamCast dashboard under the stream job settings.

## Endpoints (all require Bearer token auth)

- `POST /start` — start streaming
- `POST /stop`  — stop streaming
- `GET  /status` — check streaming status
- `GET  /health` — unauthenticated health check
