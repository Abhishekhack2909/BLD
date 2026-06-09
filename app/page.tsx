"use client";

import { KeyboardEvent, MouseEvent, WheelEvent, useEffect, useRef, useState } from "react";

type Status = "idle" | "starting" | "running" | "stopping" | "error";

type FrameMessage = {
  type: "frame";
  data: string;
  width: number;
  height: number;
};

type StatusMessage = {
  type: "status";
  status: Status;
  message?: string;
};

type ServerMessage = FrameMessage | StatusMessage;

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4000/ws";

export default function Home() {
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("Click Start Browser to launch Chromium inside Docker.");
  const [frame, setFrame] = useState<string | null>(null);
  const [viewport, setViewport] = useState({ width: 1280, height: 720 });
  const [url, setUrl] = useState("https://example.com");
  const wsRef = useRef<WebSocket | null>(null);
  const screenRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setMessage("Control socket connected.");
      console.log("[client] WebSocket opened, sending test message");
      ws.send(JSON.stringify({ type: "test" }));
    };

    ws.onmessage = (event) => {
      const payload = JSON.parse(event.data) as ServerMessage;

      if (payload.type === "frame") {
        setFrame(`data:image/jpeg;base64,${payload.data}`);
        setViewport({ width: payload.width, height: payload.height });
      }

      if (payload.type === "status") {
        setStatus(payload.status);
        if (payload.message) setMessage(payload.message);
      }
    };

    ws.onerror = () => {
      setStatus("error");
      setMessage("Could not connect to the backend WebSocket on port 4000.");
    };

    ws.onclose = () => {
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
    };

    return () => ws.close();
  }, []);

  async function startBrowser() {
    setStatus("starting");
    setMessage("Starting Docker container and Chromium. First run may build the image.");
    setFrame(null);

    const response = await fetch(`${API_URL}/api/browser/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });

    const data = await response.json();

    if (!response.ok) {
      setStatus("error");
      setMessage(data.error ?? "Failed to start browser.");
      return;
    }

    setStatus("running");
    setMessage("Browser is running. Click, type, and scroll in the screen below.");
  }

  async function stopBrowser() {
    setStatus("stopping");
    setMessage("Stopping browser container.");

    await fetch(`${API_URL}/api/browser/stop`, {
      method: "POST"
    });

    setStatus("idle");
    setFrame(null);
    setMessage("Browser stopped.");
  }

  async function navigate() {
    sendControl({ type: "navigate", url });
  }

  function sendControl(payload: Record<string, unknown>) {
    console.log("[client] sendControl called with:", payload);
    const ws = wsRef.current;
    if (!ws) {
      console.warn("[client] WebSocket is null!");
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) {
      console.warn("[client] WebSocket is not OPEN. readyState:", ws.readyState);
      return;
    }
    ws.send(JSON.stringify(payload));
  }

  function getBrowserPoint(event: MouseEvent<HTMLImageElement> | WheelEvent<HTMLImageElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * viewport.width;
    const y = ((event.clientY - rect.top) / rect.height) * viewport.height;

    return {
      x: Math.max(0, Math.min(viewport.width, Math.round(x))),
      y: Math.max(0, Math.min(viewport.height, Math.round(y)))
    };
  }

  function handleClick(event: MouseEvent<HTMLImageElement>) {
    console.log("[client] Click event triggered");
    screenRef.current?.focus();
    const point = getBrowserPoint(event);
    sendControl({ type: "click", ...point });
  }

  function handleWheel(event: WheelEvent<HTMLImageElement>) {
    console.log("[client] Wheel event triggered");
    event.preventDefault();
    const point = getBrowserPoint(event);
    sendControl({
      type: "scroll",
      ...point,
      deltaX: event.deltaX,
      deltaY: event.deltaY
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLImageElement>) {
    console.log("[client] Keydown event triggered, key:", event.key);
    if (event.key === "Tab") event.preventDefault();

    sendControl({
      type: "key",
      key: event.key,
      code: event.code,
      text: event.key.length === 1 ? event.key : undefined,
      shift: event.shiftKey,
      alt: event.altKey,
      ctrl: event.ctrlKey,
      meta: event.metaKey
    });
  }

  const canStart = status === "idle" || status === "error";
  const canStop = status === "running" || status === "starting";

  return (
    <main className="shell">
      <section className="toolbar">
        <div>
          <p className="eyebrow">BLD Assignment MVP</p>
          <h1>Remote Browser Control</h1>
        </div>

        <div className="actions">
          <input
            aria-label="Initial URL"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com"
          />
          <button onClick={navigate} disabled={status !== "running"}>
            Go
          </button>
          <button className="primary" onClick={startBrowser} disabled={!canStart}>
            {status === "starting" ? "Starting..." : "Start Browser"}
          </button>
          <button onClick={stopBrowser} disabled={!canStop}>
            Stop
          </button>
        </div>
      </section>

      <section className="statusbar">
        <span className={`dot ${status}`} />
        <span>{message}</span>
      </section>

      <section className="viewer" style={{ aspectRatio: `${viewport.width} / ${viewport.height}` }}>
        {frame ? (
          <img
            ref={screenRef}
            src={frame}
            alt="Remote Chromium browser"
            tabIndex={0}
            onClick={handleClick}
            onWheel={handleWheel}
            onKeyDown={handleKeyDown}
          />
        ) : (
          <div className="empty">
            <strong>No browser stream yet</strong>
            <span>Start Chromium to see the live screencast here.</span>
          </div>
        )}
      </section>
    </main>
  );
}
