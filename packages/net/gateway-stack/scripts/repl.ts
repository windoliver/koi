#!/usr/bin/env bun
/**
 * Interactive WebSocket REPL for the gateway — usable as a tmux pane to
 * drive the gateway-stack like a (very minimal) TUI.
 *
 * - Runs the WebSocket handshake automatically.
 * - Each line of stdin becomes one request frame.
 * - Every server frame is printed as it arrives.
 * - Ctrl-C closes cleanly with code 1000.
 *
 * Usage:
 *   bun packages/net/gateway-stack/scripts/repl.ts <ws-url> [client-id]
 */

const url = process.argv[2];
const clientId = process.argv[3] ?? "tui-repl";
if (url === undefined) {
  console.error("usage: repl.ts <ws-url> [client-id]");
  process.exit(1);
}

const ws = new WebSocket(url);
let connected = false;
let outboundReqSeq = 0;

const banner = (s: string): void => {
  process.stdout.write(`\x1b[36m[gw-repl] ${s}\x1b[0m\n`);
};

ws.onopen = (): void => {
  banner(`connected to ${url}, sending handshake (client=${clientId})`);
  ws.send(
    JSON.stringify({
      kind: "connect",
      minProtocol: 1,
      maxProtocol: 1,
      auth: { token: "dev-token" },
      client: { id: clientId, version: "0.0.0", platform: "bun" },
    }),
  );
};

ws.onmessage = (e): void => {
  const data = String(e.data);
  process.stdout.write(`\x1b[32m← ${data}\x1b[0m\n`);
  try {
    const f = JSON.parse(data) as { kind?: string; payload?: { sessionId?: string } };
    if (f.kind === "ack" && f.payload?.sessionId !== undefined && !connected) {
      connected = true;
      banner(`session=${f.payload.sessionId} — type a message + ENTER to send a request frame`);
      drainPending();
    }
  } catch {
    // ignore non-JSON
  }
};

ws.onerror = (e): void => {
  banner(`error: ${(e as ErrorEvent).message ?? e}`);
};

ws.onclose = (e): void => {
  banner(`closed code=${e.code} reason="${e.reason}"`);
  process.exit(0);
};

process.stdin.setEncoding("utf-8");
let buf = "";
const pending: string[] = [];

function emitFrame(line: string): void {
  if (line === ":quit" || line === ":q") {
    ws.close(1000, "user quit");
    return;
  }
  const frame = {
    kind: "request",
    id: crypto.randomUUID(),
    seq: outboundReqSeq++,
    payload: { text: line },
    timestamp: Date.now(),
  };
  process.stdout.write(`\x1b[33m→ ${JSON.stringify(frame)}\x1b[0m\n`);
  ws.send(JSON.stringify(frame));
}

function drainPending(): void {
  while (pending.length > 0) {
    const line = pending.shift();
    if (line !== undefined) emitFrame(line);
  }
}

process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let nl = buf.indexOf("\n");
  while (nl !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    nl = buf.indexOf("\n");
    if (line.length === 0) continue;
    if (!connected) {
      pending.push(line);
      banner(`buffered: "${line}" (waiting for handshake)`);
      continue;
    }
    emitFrame(line);
  }
});

process.on("SIGINT", () => {
  banner("SIGINT — closing");
  ws.close(1000, "ctrl-c");
});
