# ──────────────────────────────────────────────
# StreamForge — Dockerfile
# Guarantees ffmpeg is installed (bulletproof for Railway)
# ──────────────────────────────────────────────

FROM node:20-slim

# Install ffmpeg + fonts (for any text overlays)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ffmpeg \
      ca-certificates \
      fonts-dejavu-core && \
    rm -rf /var/lib/apt/lists/*

# Verify ffmpeg installed (build fails loudly if not)
RUN ffmpeg -version

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm install --production

# Copy the rest of the app
COPY . .

# Create download directory
RUN mkdir -p /tmp/streamforge/downloads

# Railway sets PORT automatically
ENV PORT=8080
EXPOSE 8080

CMD ["node", "src/server.js"]
