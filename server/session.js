const CDP = require("chrome-remote-interface");
const EventEmitter = require("events");
const net = require("net");
const { spawn } = require("child_process");
const { existsSync } = require("fs");
const path = require("path");

const IMAGE_NAME = process.env.BROWSER_IMAGE ?? "bld-remote-chromium";
const WINDOWS_DOCKER_BIN = "C:\\Program Files\\Docker\\Docker\\resources\\bin";
const WINDOWS_DOCKER_EXE = path.join(WINDOWS_DOCKER_BIN, "docker.exe");
const VIEWPORT = {
  width: Number(process.env.BROWSER_WIDTH ?? 1280),
  height: Number(process.env.BROWSER_HEIGHT ?? 720)
};

class BrowserSession extends EventEmitter {
  constructor() {
    super();
    this.state = "idle";
    this.message = "Idle.";
    this.client = null;
    this.docker = null;
    this.containerName = null;
    this.cdpPort = null;
  }

  async start(initialUrl = "https://example.com") {
    if (this.state === "running" || this.state === "starting") return;

    this.setStatus("starting", "Preparing Docker image...");
    await runCommand(dockerCommand(), ["image", "inspect", IMAGE_NAME]).catch(async () => {
      this.setStatus("starting", "Building Chromium image (first time)...");
      await runCommand(dockerCommand(), ["build", "-t", IMAGE_NAME, "./browser"]);
    });

    // Use a random free port to avoid conflicts
    this.cdpPort = await getFreePort();
    this.containerName = `bld-browser-${Date.now()}`;
    this.setStatus("starting", `Starting Chromium on port ${this.cdpPort}...`);

    // Start container with dynamic port mapping
    this.docker = spawn(
      dockerCommand(),
      [
        "run", "--rm",
        "--name", this.containerName,
        "--shm-size=512m",
        "-p", `${this.cdpPort}:9222`,
        IMAGE_NAME
      ],
      { env: dockerEnv(), stdio: ["ignore", "pipe", "pipe"] }
    );

    // Wait for "DevTools listening" from Chromium's stderr
    const cdpReady = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Chromium did not start within 60s"));
      }, 60000);

      this.docker.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        process.stderr.write(`[browser] ${text}`);
        if (text.includes("DevTools listening")) {
          clearTimeout(timeout);
          console.log("[cdp] Chromium DevTools is ready inside container");
          resolve();
        }
      });

      this.docker.stdout.on("data", (chunk) => {
        process.stdout.write(`[browser] ${chunk}`);
      });

      this.docker.on("exit", (code) => {
        clearTimeout(timeout);
        this.docker = null;
        if (this.state !== "idle") {
          this.setStatus("error", `Container exited (code ${code})`);
        }
        reject(new Error(`Container exited with code ${code}`));
      });

      this.docker.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    await cdpReady;

    // Wait for port-mapping to become available on Windows/WSL2
    this.setStatus("starting", "Connecting to browser...");
    console.log(`[cdp] Waiting for port ${this.cdpPort} to become reachable...`);

    // Try TCP socket connection first (more reliable than HTTP on WSL2)
    await waitForTcpPort("127.0.0.1", this.cdpPort, 30000);
    console.log(`[cdp] TCP port ${this.cdpPort} is open`);

    // Small extra grace
    await delay(500);

    // Connect CDP
    this.client = await CDP({ host: "127.0.0.1", port: this.cdpPort });
    const { Page, Runtime } = this.client;
    await Promise.all([Page.enable(), Runtime.enable()]);
    console.log("[cdp] CDP session connected");

    // Frame listener
    Page.screencastFrame(({ data, sessionId, metadata }) => {
      this.emit("frame", {
        data,
        width: metadata.deviceWidth || VIEWPORT.width,
        height: metadata.deviceHeight || VIEWPORT.height
      });
      Page.screencastFrameAck({ sessionId }).catch(() => undefined);
    });

    // Start screencast BEFORE navigate to capture frames
    await Page.startScreencast({
      format: "jpeg",
      quality: 70,
      everyNthFrame: 1
    });
    console.log("[cdp] Screencast started");

    // Navigate
    console.log("[cdp] Navigating to", normalizeUrl(initialUrl));
    await Page.navigate({ url: normalizeUrl(initialUrl) });

    this.setStatus("running", "Browser is running. Click, type, and scroll below.");
  }

  async stop() {
    this.setStatus("stopping", "Stopping browser...");

    if (this.client) {
      await this.client.close().catch(() => undefined);
      this.client = null;
    }

    if (this.containerName) {
      await runCommand(dockerCommand(), ["stop", this.containerName]).catch(() => undefined);
    }

    this.docker = null;
    this.containerName = null;
    this.cdpPort = null;
    this.setStatus("idle", "Idle.");
  }

  async handleInput(payload) {
    if (!this.client || this.state !== "running") return;

    const { Input, Page } = this.client;

    if (payload.type === "navigate" && typeof payload.url === "string") {
      await Page.navigate({ url: normalizeUrl(payload.url) });
      return;
    }

    if (payload.type === "click") {
      const x = Number(payload.x);
      const y = Number(payload.y);
      await Input.dispatchMouseEvent({ type: "mouseMoved", x, y });
      await delay(50);
      await Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await delay(50);
      await Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      return;
    }

    if (payload.type === "scroll") {
      let deltaX = Number(payload.deltaX ?? 0);
      let deltaY = Number(payload.deltaY ?? 0);
      if (deltaX !== 0 && Math.abs(deltaX) < 10) {
        deltaX = Math.sign(deltaX) * 20;
      }
      if (deltaY !== 0 && Math.abs(deltaY) < 10) {
        deltaY = Math.sign(deltaY) * 20;
      }
      const x = Number(payload.x);
      const y = Number(payload.y);
      await Input.dispatchMouseEvent({ type: "mouseMoved", x, y });
      await Input.dispatchMouseEvent({
        type: "mouseWheel",
        x,
        y,
        deltaX,
        deltaY
      });
      return;
    }

    if (payload.type === "key") {
      await dispatchKey(Input, payload);
    }
  }

  setStatus(status, message) {
    this.state = status;
    this.message = message;
    this.emit("status", { status, message });
  }
}

// --- Key input ---

async function dispatchKey(Input, payload) {
  const special = ["Backspace", "Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Delete", "Home", "End"];
  if (special.includes(payload.key)) {
    await keyDownUp(Input, payload.key, payload.code || payload.key);
    return;
  }
  if (typeof payload.text === "string" && payload.text.length === 1) {
    await Input.insertText({ text: payload.text });
  }
}

async function keyDownUp(Input, key, code) {
  await Input.dispatchKeyEvent({ type: "keyDown", key, code });
  await Input.dispatchKeyEvent({ type: "keyUp", key, code });
}

// --- URL ---

function normalizeUrl(url) {
  if (!url || typeof url !== "string") return "https://example.com";
  if (/^https?:\/\//i.test(url)) return url;
  return `https://${url}`;
}

// --- Docker ---

function dockerCommand() {
  if (process.platform === "win32" && existsSync(WINDOWS_DOCKER_EXE)) return WINDOWS_DOCKER_EXE;
  return "docker";
}

function dockerEnv() {
  const env = { ...process.env };
  if (process.platform === "win32" && existsSync(WINDOWS_DOCKER_BIN)) {
    env.Path = `${WINDOWS_DOCKER_BIN};${env.Path ?? ""}`;
    env.PATH = `${WINDOWS_DOCKER_BIN};${env.PATH ?? ""}`;
  }
  return env;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: dockerEnv(), stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

// --- Network ---

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

/**
 * Wait for a TCP port to accept connections. 
 * More reliable than HTTP polling on Windows/WSL2.
 */
function waitForTcpPort(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    function tryConnect() {
      if (Date.now() > deadline) {
        return reject(new Error(`Port ${port} not reachable within ${timeoutMs}ms`));
      }

      const socket = new net.Socket();
      socket.setTimeout(1000);

      socket.on("connect", () => {
        socket.destroy();
        resolve();
      });

      socket.on("error", () => {
        socket.destroy();
        setTimeout(tryConnect, 300);
      });

      socket.on("timeout", () => {
        socket.destroy();
        setTimeout(tryConnect, 300);
      });

      socket.connect(port, host);
    }

    tryConnect();
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { BrowserSession };
