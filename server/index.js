const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { BrowserSession } = require("./session");

const PORT = Number(process.env.PORT ?? 4000);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? "http://localhost:3000";

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });
const session = new BrowserSession();

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", CLIENT_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  next();
});

function broadcast(payload) {
  const encoded = JSON.stringify(payload);

  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(encoded);
    }
  }
}

session.on("status", (payload) => broadcast({ type: "status", ...payload }));
session.on("frame", (payload) => broadcast({ type: "frame", ...payload }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, browser: session.state });
});

app.post("/api/browser/start", async (req, res) => {
  try {
    await session.start(req.body?.url);
    res.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown start error";
    res.status(500).json({ error: message });
  }
});

app.post("/api/browser/stop", async (_req, res) => {
  await session.stop();
  res.json({ ok: true });
});

wss.on("connection", (socket) => {
  socket.send(
    JSON.stringify({
      type: "status",
      status: session.state,
      message: session.message
    })
  );

  socket.on("message", async (raw) => {
    try {
      const payload = JSON.parse(raw.toString());
      await session.handleInput(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Input handling failed";
      socket.send(JSON.stringify({ type: "status", status: "error", message }));
    }
  });
});

process.on("SIGINT", async () => {
  await session.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await session.stop();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`Control server listening on http://localhost:${PORT}`);
});
