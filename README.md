# BLD Remote Browser Control

A local MVP for the BLD SDE Intern assignment: start Chromium inside Docker, stream its screen to a web UI, and control it with click, scroll, and keyboard events.

## What Works

- Next.js web UI on `http://localhost:3000`
- Node.js control server on `http://localhost:4000`
- Starts a local Docker container running headless Chromium
- Streams Chromium frames through Chrome DevTools Protocol screencast
- Sends click, scroll, typing, backspace, enter, tab, and escape events to Chromium
- Stops and cleans up the browser container

## Requirements

- Node.js 20+
- npm
- Docker Desktop

Docker is required because the assignment asks the controlled browser to run inside a local Docker container.

On Windows, if `docker` is not recognized in a terminal but Docker Desktop is installed, restart the terminal or add this folder to PATH:

```txt
C:\Program Files\Docker\Docker\resources\bin
```

## Run Locally

Install dependencies:

```bash
npm install
```

Start the app:

```bash
npm run dev
```

Open:

```txt
http://localhost:3000
```

Click **Start Browser**. On the first run, the backend builds the Chromium image from `browser/Dockerfile`, so startup can take a little while.

## Alternative Docker Compose Run

After Docker Desktop is installed and running:

```bash
docker compose up --build
```

This runs the app in a Node container and mounts the Docker socket so the backend can start the Chromium browser container.

## Architecture

```txt
Next.js UI
  -> WebSocket / HTTP
Node.js backend
  -> docker run
Chromium Docker container
  -> Chrome DevTools Protocol
```

The backend connects to Chromium with CDP. It uses `Page.startScreencast` for live frames and `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, and `Input.insertText` for remote control.

## Current Limitations

- One browser session at a time
- No authentication because this is local-only
- First startup depends on Docker image build time
- Keyboard support covers common keys, not every browser shortcut
- Frame streaming is JPEG-over-WebSocket, not video encoded streaming

## Next Steps

- Add multiple browser sessions
- Improve keyboard shortcut handling
- Add a visible cursor overlay
- Add reconnect/resume behavior
- Add health checks for Docker availability
- Add automated integration tests around the backend session lifecycle
