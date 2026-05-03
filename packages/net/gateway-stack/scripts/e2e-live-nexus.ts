#!/usr/bin/env bun
/**
 * E2E driver: exercises createGatewayStack against a live Nexus.
 * Not part of CI — run manually with NEXUS_URL/NEXUS_API_KEY set.
 */

import type { GatewayAuthenticator, Transport, TransportHandler } from "@koi/gateway";
import { createHttpTransport } from "@koi/nexus-client";
import { createGatewayStack } from "../src/index.js";

function readEnv(): { readonly url: string; readonly apiKey: string } {
  const url = process.env.NEXUS_URL;
  const apiKey = process.env.NEXUS_API_KEY;
  if (url === undefined || apiKey === undefined) {
    console.error("NEXUS_URL and NEXUS_API_KEY required");
    process.exit(1);
  }
  return { url, apiKey };
}
const { url: NEXUS_URL, apiKey: NEXUS_API_KEY } = readEnv();

function makeAuth(): GatewayAuthenticator {
  return {
    authenticate: async () => ({ ok: true, sessionId: "s", agentId: "a", metadata: {} }),
  };
}

function makeTransport(): Transport {
  let _h: TransportHandler | undefined;
  return {
    listen: async (_p, h) => {
      _h = h;
    },
    close: () => {
      _h = undefined;
    },
    connections: () => 0,
  };
}

const sessionId = `e2e-${Date.now()}`;

async function main(): Promise<void> {
  const stack = createGatewayStack(
    { nexus: { instanceId: "e2e-1", basePath: "global/gateway/sessions" } },
    {
      transport: makeTransport(),
      auth: makeAuth(),
      nexusTransport: createHttpTransport({ url: NEXUS_URL, apiKey: NEXUS_API_KEY }),
    },
  );

  if (stack.nexus === undefined) throw new Error("nexus handle missing");

  // 1. set + read back from Nexus
  console.log("[1] set session →", sessionId);
  await stack.nexus.store.set({
    id: sessionId,
    agentId: "agent-1",
    connectedAt: Date.now(),
    lastHeartbeat: Date.now(),
    seq: 0,
    remoteSeq: 0,
    metadata: { e2e: true },
  });

  // wait for write queue immediate-write to flush
  await new Promise<void>((r) => setTimeout(r, 200));

  // 2. health (live nexus)
  const h = await stack.health();
  console.log("[2] health (healthy):", JSON.stringify(h));
  if (h.status !== "ok" || h.nexus?.mode !== "healthy") {
    throw new Error(`expected healthy, got ${JSON.stringify(h)}`);
  }

  // 3. fresh stack to drop the cache, then read back from Nexus
  console.log("[3] read-back from a fresh stack instance (no local cache)");
  const reader = createGatewayStack(
    { nexus: { instanceId: "e2e-reader" } },
    {
      transport: makeTransport(),
      auth: makeAuth(),
      nexusTransport: createHttpTransport({ url: NEXUS_URL, apiKey: NEXUS_API_KEY }),
    },
  );
  if (reader.nexus === undefined) throw new Error("reader nexus handle missing");
  const got = await reader.nexus.store.get(sessionId);
  console.log("    →", JSON.stringify(got));
  if (!got.ok) throw new Error(`expected ok, got error: ${got.error.message}`);
  if (got.value.id !== sessionId) throw new Error(`session id mismatch`);
  if (got.value.agentId !== "agent-1") throw new Error(`agentId mismatch`);

  // 4. healthHandler returns 200 JSON when healthy
  const okRes = await stack.healthHandler(new Request("http://x/health"));
  console.log(`[4] healthHandler healthy → status=${okRes.status}`);
  if (okRes.status !== 200) throw new Error(`expected 200, got ${okRes.status}`);

  // 5. simulate Nexus going away → expect failover
  console.log("[5] swap to a broken transport, force a failed read, expect degraded");
  const broken = createGatewayStack(
    { nexus: { degradation: { failureThreshold: 1 } } },
    {
      transport: makeTransport(),
      auth: makeAuth(),
      // point at a closed port so the call fails
      nexusTransport: createHttpTransport({ url: "http://127.0.0.1:1", apiKey: "x" }),
    },
  );
  if (broken.nexus === undefined) throw new Error("broken nexus handle missing");
  const r = await broken.nexus.store.get("nonexistent");
  console.log("    get →", JSON.stringify(r));
  console.log("    degradation.mode:", broken.nexus.degradation().mode);
  const brokenH = await broken.health();
  console.log("    health:", JSON.stringify(brokenH));
  if (brokenH.status !== "degraded") throw new Error("expected degraded");
  const degradedRes = await broken.healthHandler(new Request("http://x/health"));
  console.log(`    healthHandler degraded → status=${degradedRes.status}`);
  if (degradedRes.status !== 503) throw new Error(`expected 503, got ${degradedRes.status}`);

  // 6. cleanup
  console.log("[6] delete session + dispose");
  await stack.nexus.store.delete(sessionId);
  await new Promise<void>((r) => setTimeout(r, 200));
  await stack.stop();
  await reader.stop();
  await broken.stop();

  console.log("\n✅ ALL E2E CHECKS PASSED");
}

await main();
