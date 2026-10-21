FROM node:20-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 ffmpeg curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

ENV PORT=8080
EXPOSE 8080

# yt-dlp sering perlu update karena YouTube/TikTok berubah; update tiap start
CMD ["sh", "-c", "yt-dlp -U || true; node server.js"]
