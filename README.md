# BLD Remote Browser Control

A high-performance remote browser control system built for the BLD SDE Intern assignment. The system spins up Chromium in a local Docker container, streams frames to a Next.js frontend, and forwards interactive events (clicks, scrolls, keystrokes) back to the container in real time.

---

## Key Features
- **Dockerized Headless Chromium**: Starts/stops browser containers dynamically on request.
- **Live Frame Streaming**: Streams Chromium screen frames over WebSockets using Chrome DevTools Protocol (CDP) screencasting.
- **Interactive Control**: Relays mouse clicks, scroll wheels, typing, and special key commands (Backspace, Enter, Tab, etc.) back to the browser.
- **Tunneling Proxy**: Integrated `socat` to securely forward debugger TCP connections from the host to the container loopback interface.

---

## Tech Stack
- **Frontend**: Next.js, React, Vanilla CSS
- **Backend**: Node.js, Express, WebSocket (`ws`)
- **Container**: Docker, Debian Bookworm, Headless Chromium, `socat`

---

## Setup & Local Run

### Prerequisites
- Node.js 20+ and npm
- Docker Desktop (make sure it is running)

### Running the App
1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```
2. Start the Next.js frontend and Node.js backend concurrently:
   ```bash
   npm run dev
   ```
3. Open **`http://localhost:3000`** in your browser.
4. Input a URL and click **Start Browser** to initiate the remote session.
