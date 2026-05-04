#!/usr/bin/env bun
/**
 * Resume a session against a different gateway instance.
 *
 * Usage: bun ws-resume.ts <ws-url> <session-id> [client-id]
 *
 * Sends a resume connect frame (sessionId set), prints all server frames,
 * then exits. Used by tmux HA validation to verify cross-instance handoff.
 */

const url = process.argv[2];
const sessionId = process.argv[3];
const clientId = process.argv[4] ?? "ha-client";
if (url === undefined || sessionId === undefined) {
  console.error("usage: ws-resume.ts <ws-url> <session-id> [client-id]");
  process.exit(1);
}

const ws = new WebSocket(url);

ws.onopen = (): void => {
  console.log(`[resume] connected to ${url} as session=${sessionId}`);
  const connect = {
    kind: "connect",
    minProtocol: 1,
    maxProtocol: 1,
    sessionId,
    auth: { token: "dev-token" },
    client: { id: clientId, version: "0.0.0", platform: "bun" },
  };
  ws.send(JSON.stringify(connect));
};

ws.onmessage = (e): void => {
  const data = String(e.data);
  console.log(`[resume] recv: ${data}`);
  setTimeout(() => ws.close(1000, "resume done"), 200);
};

ws.onerror = (e): void => {
  console.error(`[resume] error:`, (e as ErrorEvent).message ?? e);
};

ws.onclose = (e): void => {
  console.log(`[resume] closed code=${e.code} reason=${e.reason}`);
  process.exit(0);
};

setTimeout(() => {
  console.error("[resume] timeout");
  process.exit(1);
}, 8_000);
