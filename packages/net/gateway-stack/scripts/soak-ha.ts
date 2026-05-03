#!/usr/bin/env bun
/**
 * Soak / failover harness for the gateway HA flow.
 *
 * Drives N concurrent WebSocket sessions across two gateway instances
 * (gwA + gwB) sharing a Nexus session store. For each session: connect
 * to gwA, send a request, disconnect, reconnect to gwB (HA handoff),
 * send another request, disconnect. Verifies that:
 *
 *   - every session lands a record in Nexus
 *   - ownerInstance flips to the latest serving gateway
 *   - outbound seq advances monotonically across the handoff
 *   - the gateway never closes with SESSION_STORE_FAILURE (4008) under load
 *
 * Usage:
 *   N=20 NEXUS_URL=... NEXUS_API_KEY=... GW_A_WS=... GW_B_WS=... \
 *     bun packages/net/gateway-stack/scripts/soak-ha.ts
 */

import { createHttpTransport, type NexusTransport } from "@koi/nexus-client";

const N = Number.parseInt(process.env.N ?? "10", 10);
const NEXUS_URL = process.env.NEXUS_URL;
const NEXUS_API_KEY = process.env.NEXUS_API_KEY;
const GW_A_WS = process.env.GW_A_WS ?? "ws://127.0.0.1:19500";
const GW_B_WS = process.env.GW_B_WS ?? "ws://127.0.0.1:19510";
const GW_B_INSTANCE = process.env.GW_B_INSTANCE ?? "gwB";

if (NEXUS_URL === undefined || NEXUS_API_KEY === undefined) {
  console.error("set NEXUS_URL and NEXUS_API_KEY");
  process.exit(1);
}

interface ConnectAck {
  readonly kind: "ack";
  readonly id: string;
  readonly seq: number;
  readonly payload: {
    readonly sessionId: string;
    readonly remoteSeq?: number;
  };
}

async function driveOnce(
  url: string,
  clientId: string,
): Promise<{ sessionId: string; outboundSeq: number; closeCode: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let lastSeq = 0;
    let sessionId = "";
    const deadline = setTimeout(() => {
      ws.close();
      reject(new Error(`timeout for ${clientId}`));
    }, 6_000);

    ws.onopen = () => {
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
    ws.onmessage = (e) => {
      let f: ConnectAck;
      try {
        f = JSON.parse(String(e.data)) as ConnectAck;
      } catch {
        return;
      }
      if (f.kind !== "ack") return;
      if (f.payload?.sessionId !== undefined) sessionId = f.payload.sessionId;
      lastSeq = Math.max(lastSeq, f.seq);
      if (sessionId !== "" && f.payload?.sessionId !== undefined) {
        // After handshake, fire one request and disconnect.
        ws.send(
          JSON.stringify({
            kind: "request",
            id: crypto.randomUUID(),
            seq: 0,
            payload: { client: clientId },
            timestamp: Date.now(),
          }),
        );
        setTimeout(() => ws.close(1000, "soak done"), 150);
      }
    };
    ws.onerror = (e) => {
      clearTimeout(deadline);
      reject(new Error(`ws error: ${(e as ErrorEvent).message ?? e}`));
    };
    ws.onclose = (e) => {
      clearTimeout(deadline);
      resolve({ sessionId, outboundSeq: lastSeq, closeCode: e.code });
    };
  });
}

interface NexusRecord {
  readonly session: { readonly id: string; readonly seq: number; readonly remoteSeq: number };
  readonly ownerInstance: string;
}

async function readRecord(
  transport: NexusTransport,
  basePath: string,
  sessionId: string,
): Promise<NexusRecord | undefined> {
  const enc = Buffer.from(sessionId, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const path = `${basePath}/${enc}.json`;
  const r = await transport.call<Record<string, { __type__?: string; data?: string } | null>>(
    "read_bulk",
    { paths: [path] },
  );
  if (!r.ok) throw new Error(`read_bulk failed: ${r.error.message}`);
  const entries = Object.values(r.value ?? {});
  const entry = entries[0];
  if (entry === null || entry === undefined) return undefined;
  if (entry.__type__ !== "bytes" || typeof entry.data !== "string") return undefined;
  const text = Buffer.from(entry.data, "base64").toString("utf-8");
  return JSON.parse(text) as NexusRecord;
}

const transport = createHttpTransport({ url: NEXUS_URL, apiKey: NEXUS_API_KEY });
const basePath = "global/gateway/sessions";

interface Outcome {
  readonly clientId: string;
  readonly aSessionId: string;
  readonly aSeq: number;
  readonly aClose: number;
  readonly bSessionId: string;
  readonly bSeq: number;
  readonly bClose: number;
  readonly afterAOwner: string | undefined;
  readonly afterAseq: number | undefined;
  readonly afterBOwner: string | undefined;
  readonly afterBseq: number | undefined;
}

const SETTLE_MS = Number.parseInt(process.env.SETTLE_MS ?? "500", 10);

const RUN_ID = process.env.RUN_ID ?? Date.now().toString(36);

async function runOne(i: number): Promise<Outcome> {
  const clientId = `soak-${RUN_ID}-${i.toString().padStart(3, "0")}`;
  const a = await driveOnce(GW_A_WS, clientId);
  // Wait long enough for the async write queue (default flushIntervalMs)
  // to flush gwA's final persist before reading and before reconnecting.
  await new Promise<void>((res) => setTimeout(res, SETTLE_MS));
  const recA = await readRecord(transport, basePath, a.sessionId);
  const b = await driveOnce(GW_B_WS, clientId);
  await new Promise<void>((res) => setTimeout(res, SETTLE_MS));
  const recB = await readRecord(transport, basePath, b.sessionId);
  return {
    clientId,
    aSessionId: a.sessionId,
    aSeq: a.outboundSeq,
    aClose: a.closeCode,
    bSessionId: b.sessionId,
    bSeq: b.outboundSeq,
    bClose: b.closeCode,
    afterAOwner: recA?.ownerInstance,
    afterAseq: recA?.session.seq,
    afterBOwner: recB?.ownerInstance,
    afterBseq: recB?.session.seq,
  };
}

console.log(JSON.stringify({ kind: "soak_started", N, GW_A_WS, GW_B_WS }));
const start = Date.now();
const outcomes = await Promise.all(
  Array.from({ length: N }, (_, i) => runOne(i).catch((e: Error) => ({ error: e.message, i }))),
);
const elapsedMs = Date.now() - start;

interface Summary {
  total: number;
  errors: number;
  badCloseA: number;
  badCloseB: number;
  bothPersisted: number;
  ownerDidNotFlip: number;
  seqDidNotAdvance: number;
  sessionIdMismatch: number;
}

const summary: Summary = {
  total: outcomes.length,
  errors: outcomes.filter((o) => "error" in o).length,
  badCloseA: 0,
  badCloseB: 0,
  bothPersisted: 0,
  ownerDidNotFlip: 0,
  seqDidNotAdvance: 0,
  sessionIdMismatch: 0,
};
for (const o of outcomes) {
  if ("error" in o) continue;
  if (o.aClose !== 1000) summary.badCloseA++;
  if (o.bClose !== 1000) summary.badCloseB++;
  if (o.afterAOwner !== undefined && o.afterBOwner !== undefined) summary.bothPersisted++;
  if (o.afterBOwner !== GW_B_INSTANCE) summary.ownerDidNotFlip++;
  if (o.afterBseq !== undefined && o.afterAseq !== undefined && o.afterBseq <= o.afterAseq)
    summary.seqDidNotAdvance++;
  if (o.aSessionId !== o.bSessionId) summary.sessionIdMismatch++;
}

console.log(JSON.stringify({ kind: "soak_summary", elapsedMs, ...summary }, null, 2));
const failures = outcomes.filter(
  (o) => "error" in o || o.aClose !== 1000 || o.bClose !== 1000 || o.afterBOwner !== GW_B_INSTANCE,
);
if (failures.length > 0) {
  console.log(JSON.stringify({ kind: "soak_failures", failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ kind: "soak_passed" }));
process.exit(0);
