#!/usr/bin/env bun
/**
 * Tiny WebSocket driver — connects, completes the gateway handshake,
 * sends one request frame, prints every server frame, then exits.
 *
 * Usage: bun ws-drive.ts <ws-url> [client-id]
 */

const url = process.argv[2];
const clientId = process.argv[3] ?? "tmux-driver";
if (url === undefined) {
  console.error("usage: ws-drive.ts <ws-url> [client-id]");
  process.exit(1);
}

const ws = new WebSocket(url);

const received: string[] = [];

ws.onopen = (): void => {
  console.log(`[driver] connected to ${url}`);
  const connect = {
    kind: "connect",
    minProtocol: 1,
    maxProtocol: 1,
    auth: { token: "dev-token" },
    client: { id: clientId, version: "0.0.0", platform: "bun" },
  };
  ws.send(JSON.stringify(connect));
};

ws.onmessage = (e): void => {
  const data = String(e.data);
  received.push(data);
  console.log(`[driver] recv: ${data}`);

  // After handshake ack, send one request frame and disconnect.
  try {
    const f = JSON.parse(data) as { kind?: string };
    if (f.kind === "ack" && received.length === 1) {
      const req = {
        kind: "request",
        id: crypto.randomUUID(),
        seq: 0,
        payload: { hello: "from-tmux" },
        timestamp: Date.now(),
      };
      ws.send(JSON.stringify(req));
      // close shortly so the server has time to dispatch
      setTimeout(() => ws.close(1000, "driver done"), 200);
    }
  } catch {
    // non-JSON server frame — ignore
  }
};

ws.onerror = (e): void => {
  console.error(`[driver] error:`, (e as ErrorEvent).message ?? e);
};

ws.onclose = (e): void => {
  console.log(`[driver] closed code=${e.code} reason=${e.reason}`);
  process.exit(0);
};

// Hard timeout so we never hang
setTimeout(() => {
  console.error("[driver] timeout");
  process.exit(1);
}, 8_000);
