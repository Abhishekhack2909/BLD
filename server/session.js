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
    this.frameInFlight = false;
  }

  async start(initialUrl = "https://example.com") {
    if (this.state === "running" || this.state === "starting") return;

    this.setStatus("starting", "Preparing Docker image.");
    await runCommand(dockerCommand(), ["image", "inspect", IMAGE_NAME]).catch(async () => {
      await runCommand(dockerCommand(), ["build", "-t", IMAGE_NAME, "./browser"]);
    });

    this.cdpPort = await getFreePort();
    this.containerName = `bld-remote-browser-${Date.now()}`;
    this.setStatus("starting", `Starting Chromium container on CDP port ${this.cdpPort}.`);

    this.docker = spawn(
      dockerCommand(),
      [
        "run",
        "--rm",
        "--name",
        this.containerName,
        "--shm-size=512m",
        "-p",
        `${this.cdpPort}:9222`,
        IMAGE_NAME
      ],
      { env: dockerEnv(), stdio: ["ignore", "pipe", "pipe"] }
    );

    this.docker.stdout.on("data", (chunk) => process.stdout.write(`[browser] ${chunk}`));
    this.docker.stderr.on("data", (chunk) => process.stderr.write(`[browser] ${chunk}`));
    this.docker.on("exit", () => {
      this.docker = null;
      if (this.state !== "idle") {
        this.setStatus("idle", "Chromium container exited.");
      }
    });

    await waitForCdp(this.cdpPort);
    // Small extra grace so port mapping is fully ready on Windows/WSL
    await delay(500);

    this.client = await CDP({ host: "127.0.0.1", port: this.cdpPort });
    const { Page, Runtime } = this.client;

    await Promise.all([Page.enable(), Runtime.enable()]);

    Page.screencastFrame(({ data, sessionId, metadata }) => {
      this.emit("frame", {
        data,
        width: metadata.deviceWidth || VIEWPORT.width,
        height: metadata.deviceHeight || VIEWPORT.height
      });
      Page.screencastFrameAck({ sessionId }).catch(() => undefined);
    });

    // Start screencast BEFORE navigating so we capture frames from page load
    await Page.startScreencast({
      format: "jpeg",
      quality: 70,
      everyNthFrame: 1
    });

    console.log("[cdp] Screencast started, navigating to", normalizeUrl(initialUrl));
    await Page.navigate({ url: normalizeUrl(initialUrl) });

    this.setStatus("running", "Browser is running. Click, type, and scroll in the screen below.");
  }

  async stop() {
    this.setStatus("stopping", "Stopping browser.");

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

      await Input.dispatchMouseEvent({
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1
      });
      await Input.dispatchMouseEvent({
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1
      });
      return;
    }

    if (payload.type === "scroll") {
      await Input.dispatchMouseEvent({
        type: "mouseWheel",
        x: Number(payload.x),
        y: Number(payload.y),
        deltaX: Number(payload.deltaX ?? 0),
        deltaY: Number(payload.deltaY ?? 0)
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

async function dispatchKey(Input, payload) {
  if (payload.key === "Backspace") {
    await keyDownUp(Input, "Backspace", "Backspace");
    return;
  }

  if (payload.key === "Enter") {
    await keyDownUp(Input, "Enter", "Enter");
    return;
  }

  if (payload.key === "Tab") {
    await keyDownUp(Input, "Tab", "Tab");
    return;
  }

  if (payload.key === "Escape") {
    await keyDownUp(Input, "Escape", "Escape");
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

function normalizeUrl(url) {
  if (!url || typeof url !== "string") return "https://example.com";
  if (/^https?:\/\//i.test(url)) return url;
  return `https://${url}`;
}

function dockerCommand() {
  if (process.platform === "win32" && existsSync(WINDOWS_DOCKER_EXE)) {
    return WINDOWS_DOCKER_EXE;
  }

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

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `${command} ${args.join(" ")} exited with ${code}`));
      }
    });
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}

async function waitForCdp(port) {
  // Give Docker port mapping time to initialize on Windows/WSL
  await delay(2000);

  const deadline = Date.now() + 45000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        console.log(`[cdp] Chromium DevTools ready on port ${port}`);
        return;
      }
    } catch (_error) {
      // not ready yet
    }
    await delay(300);
  }

  throw new Error("Timed out waiting for Chromium DevTools endpoint.");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { BrowserSession };
