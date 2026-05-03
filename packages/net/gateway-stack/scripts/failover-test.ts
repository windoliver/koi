#!/usr/bin/env bun
/**
 * Mid-flight failover test:
 *   1. Connect to gwA, send a request, leave the connection open
 *   2. Pause to let the seq advance and persist
 *   3. Kill -9 gwA (simulating a crash)
 *   4. Reconnect to gwB with same client.id
 *   5. Verify gwB recovers seq from Nexus and serves cleanly
 *
 * Usage:
 *   GW_A_PID=<pid> NEXUS_URL=... NEXUS_API_KEY=... \
 *     bun packages/net/gateway-stack/scripts/failover-test.ts
 */

import { createHttpTransport } from "@koi/nexus-client";

const GW_A_WS = "ws://127.0.0.1:19500";
const GW_B_WS = "ws://127.0.0.1:19510";
const GW_A_PID = process.env.GW_A_PID;
const NEXUS_URL = process.env.NEXUS_URL;
const NEXUS_API_KEY = process.env.NEXUS_API_KEY;
const CLIENT_ID = process.env.CLIENT_ID ?? "failover-client";

if (GW_A_PID === undefined || NEXUS_URL === undefined || NEXUS_API_KEY === undefined) {
  console.error("set GW_A_PID, NEXUS_URL, NEXUS_API_KEY");
  process.exit(1);
}

interface Ack {
  kind: string;
  seq: number;
  payload: { sessionId?: string; remoteSeq?: number };
}

const transport = createHttpTransport({ url: NEXUS_URL, apiKey: NEXUS_API_KEY });
const enc = Buffer.from(`sess-${Buffer.from(CLIENT_ID).toString("hex")}`, "utf-8")
  .toString("base64")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");
const path = `global/gateway/sessions/${enc}.json`;

async function readNexusRecord(): Promise<
  { ownerInstance: string; seq: number; remoteSeq: number } | undefined
> {
  const r = await transport.call<Record<string, { __type__?: string; data?: string } | null>>(
    "read_bulk",
    { paths: [path] },
  );
  if (!r.ok) return undefined;
  const entry = Object.values(r.value ?? {})[0];
  if (entry === null || entry === undefined || typeof entry.data !== "string") return undefined;
  const text = Buffer.from(entry.data, "base64").toString("utf-8");
  const rec = JSON.parse(text) as {
    session: { seq: number; remoteSeq: number };
    ownerInstance: string;
  };
  return {
    ownerInstance: rec.ownerInstance,
    seq: rec.session.seq,
    remoteSeq: rec.session.remoteSeq,
  };
}

console.log("=== STEP 1: connect to gwA, drive 5 frames, keep open ===");
const aWs = new WebSocket(GW_A_WS);
const aSeq: number[] = [];
let aSessionId = "";
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("gwA connect timeout")), 4_000);
  aWs.onopen = (): void => {
    aWs.send(
      JSON.stringify({
        kind: "connect",
        minProtocol: 1,
        maxProtocol: 1,
        auth: { token: "dev-token" },
        client: { id: CLIENT_ID, version: "0.0.0", platform: "bun" },
      }),
    );
  };
  aWs.onmessage = (e): void => {
    const f = JSON.parse(String(e.data)) as Ack;
    if (f.kind !== "ack") return;
    aSeq.push(f.seq);
    if (f.payload?.sessionId !== undefined && aSessionId === "") {
      aSessionId = f.payload.sessionId;
      // Send 5 request frames in sequence
      for (let i = 0; i < 5; i++) {
        aWs.send(
          JSON.stringify({
            kind: "request",
            id: crypto.randomUUID(),
            seq: i,
            payload: { i },
            timestamp: Date.now(),
          }),
        );
      }
      // Wait for acks
      setTimeout(() => {
        clearTimeout(timer);
        resolve();
      }, 300);
    }
  };
  aWs.onerror = (e): void => {
    clearTimeout(timer);
    reject(new Error(`gwA error: ${(e as ErrorEvent).message}`));
  };
});
console.log(`gwA: sessionId=${aSessionId}, ack-seqs=${JSON.stringify(aSeq)}`);

console.log("=== STEP 2: wait for write queue flush ===");
await new Promise<void>((res) => setTimeout(res, 600));
const before = await readNexusRecord();
console.log(`Nexus before kill: ${JSON.stringify(before)}`);

console.log(`=== STEP 3: kill -9 gwA (pid=${GW_A_PID}) ===`);
await Bun.spawn(["kill", "-9", GW_A_PID]).exited;
await new Promise<void>((res) => setTimeout(res, 200));
const afterKill = await readNexusRecord();
console.log(`Nexus after kill: ${JSON.stringify(afterKill)}`);

console.log("=== STEP 4: reconnect to gwB ===");
const bWs = new WebSocket(GW_B_WS);
const bSeq: number[] = [];
let bSessionId = "";
let bRemoteSeq: number | undefined;
let bClose = 0;
await new Promise<void>((resolve) => {
  const timer = setTimeout(() => {
    bWs.close();
    resolve();
  }, 4_000);
  bWs.onopen = (): void => {
    bWs.send(
      JSON.stringify({
        kind: "connect",
        minProtocol: 1,
        maxProtocol: 1,
        auth: { token: "dev-token" },
        client: { id: CLIENT_ID, version: "0.0.0", platform: "bun" },
      }),
    );
  };
  bWs.onmessage = (e): void => {
    const f = JSON.parse(String(e.data)) as Ack;
    if (f.kind !== "ack") return;
    bSeq.push(f.seq);
    if (f.payload?.sessionId !== undefined && bSessionId === "") {
      bSessionId = f.payload.sessionId;
      bRemoteSeq = f.payload.remoteSeq;
      bWs.send(
        JSON.stringify({
          kind: "request",
          id: crypto.randomUUID(),
          seq: 0,
          payload: { after: "failover" },
          timestamp: Date.now(),
        }),
      );
      setTimeout(() => bWs.close(1000, "failover done"), 200);
    }
  };
  bWs.onclose = (e): void => {
    clearTimeout(timer);
    bClose = e.code;
    resolve();
  };
});
console.log(
  `gwB: sessionId=${bSessionId}, ack-seqs=${JSON.stringify(bSeq)}, remoteSeq=${bRemoteSeq}, close=${bClose}`,
);

await new Promise<void>((res) => setTimeout(res, 600));
const after = await readNexusRecord();
console.log(`Nexus after gwB: ${JSON.stringify(after)}`);

const passed = bClose === 1000 && bSessionId === aSessionId && after?.ownerInstance === "gwB";
console.log(
  JSON.stringify({
    kind: "failover_result",
    passed,
    sessionMatched: bSessionId === aSessionId,
    cleanClose: bClose === 1000,
    ownerFlipped: after?.ownerInstance === "gwB",
  }),
);
process.exit(passed ? 0 : 1);
