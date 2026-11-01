# Playwright's own image: Chromium and its system libraries are preinstalled and
# built for both arm64 and amd64, which is what the old PhantomJS image could
# never offer.
#
# This tag MUST match the playwright version in package-lock.json — the image
# ships one browser build, and the library refuses any other. After bumping
# playwright, bump this line too.
FROM mcr.microsoft.com/playwright:v1.64.0-noble

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    # Inside the container the UI must listen on all interfaces; the port is
    # still published to 127.0.0.1 only by compose.
    SCRAPPER_UI_HOST=0.0.0.0 \
    SCRAPPER_DOWNLOAD_PATH=/data/download

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip tini \
    && pip3 install --break-system-packages --no-cache-dir -U yt-dlp \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY main.js ./
COPY lib ./lib
COPY config ./config
COPY scraper ./scraper
COPY jobs ./jobs
COPY cmd ./cmd
COPY ui ./ui

# The image runs as Playwright's unprivileged user; /data is mounted from the host.
RUN mkdir -p /data/download /app/logs && chown -R pwuser:pwuser /app /data

USER pwuser

EXPOSE 4321

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "ui/server.js"]
