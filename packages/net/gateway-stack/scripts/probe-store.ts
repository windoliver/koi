#!/usr/bin/env bun

/**
 * Standalone probe — exercises NexusSessionStore.get/set/delete against
 * a real Nexus to surface helper-shape mismatches that the gateway
 * silently turns into 4008 SESSION_STORE_FAILURE.
 *
 * Env: NEXUS_URL, NEXUS_API_KEY (required)
 */

import { createHttpTransport } from "@koi/nexus-client";
import { createNexusSessionStore } from "../../gateway-nexus/src/nexus-session-store.js";

const NEXUS_URL = process.env.NEXUS_URL;
const NEXUS_API_KEY = process.env.NEXUS_API_KEY;
if (NEXUS_URL === undefined || NEXUS_API_KEY === undefined) {
  console.error("set NEXUS_URL and NEXUS_API_KEY");
  process.exit(1);
}

const transport = createHttpTransport({ url: NEXUS_URL, apiKey: NEXUS_API_KEY });
const handle = createNexusSessionStore({
  transport,
  config: { instanceId: "probe" },
  onError: (e) => console.log("[onError]", JSON.stringify(e)),
});

const id = `probe-${Date.now()}`;
console.log("=== get(missing) ===");
const r1 = await handle.store.get(id);
console.log(JSON.stringify(r1));

console.log("=== set ===");
const r2 = await handle.store.set({
  id,
  agentId: "probe-agent",
  connectedAt: Date.now(),
  lastHeartbeat: Date.now(),
  seq: 0,
  remoteSeq: 0,
  metadata: {},
});
console.log(JSON.stringify(r2));

await new Promise<void>((res) => setTimeout(res, 200));

console.log("=== degradation after set ===");
console.log(JSON.stringify(handle.degradation()));

console.log("=== get(after-set) (cache hit) ===");
const r3 = await handle.store.get(id);
console.log(r3.ok ? `ok, agentId=${r3.value.agentId}` : `err: ${JSON.stringify(r3.error)}`);

console.log("=== delete ===");
const r4 = await handle.store.delete(id);
console.log(JSON.stringify(r4));

console.log("=== get(after-delete) (cache miss → Nexus) ===");
const r5 = await handle.store.get(id);
console.log(r5.ok ? `ok` : `err: ${JSON.stringify(r5.error)}`);

await handle.dispose();
process.exit(0);
