FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     chromium \
     socat \
     ca-certificates \
     fonts-liberation \
     fonts-noto-color-emoji \
     libglib2.0-0 \
     libnss3 \
     libatk1.0-0 \
     libatk-bridge2.0-0 \
     libcups2 \
     libdrm2 \
     libxkbcommon0 \
     libxcomposite1 \
     libxdamage1 \
     libxfixes3 \
     libxrandr2 \
     libgbm1 \
     libasound2 \
  && rm -rf /var/lib/apt/lists/*

EXPOSE 9222

CMD ["sh", "-c", "chromium --headless --no-sandbox --disable-dev-shm-usage --disable-gpu --disable-software-rasterizer --disable-setuid-sandbox --remote-debugging-port=9223 --remote-allow-origins=* --window-size=1280,720 --hide-scrollbars --mute-audio about:blank & socat TCP-LISTEN:9222,fork,reuseaddr TCP:127.0.0.1:9223"]
