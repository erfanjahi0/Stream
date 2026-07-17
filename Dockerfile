FROM node:20-slim

# ffmpeg pushes RTMP to YouTube. curl handles resumable large-file downloads
# from Google Drive so we don't restart from zero on every network hiccup.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

ENV PORT=8080
ENV CACHE_DIR=/data/streamcast
# Railway can mount a persistent volume at /data — files survive redeploys.
VOLUME ["/data"]

EXPOSE 8080
CMD ["node", "server.js"]
