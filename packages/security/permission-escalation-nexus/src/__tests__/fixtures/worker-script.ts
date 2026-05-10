/**
 * Layer-2 worker fixture. Spawned as a child process by two-process.test.ts.
 * Reads config from env, calls escalation.request(), prints decision JSON to
 * stdout. Used to prove cross-process HTTP transport semantics end-to-end.
 */
import { createHttpTransport } from "@koi/nexus-client";
import { createNexusPermissionEscalation } from "../../nexus-permission-escalation.js";

const url = process.env.NEXUS_URL;
const requestId = process.env.REQUEST_ID;
const purpose = process.env.PURPOSE ?? "default purpose";
const ttlMs = Number(process.env.TTL_MS ?? "30000");
if (url === undefined || requestId === undefined) {
  console.error("missing NEXUS_URL or REQUEST_ID");
  process.exit(2);
}

const transport = createHttpTransport({ url });
const escalation = createNexusPermissionEscalation({
  transport,
  agentId: "agent:worker" as never,
  coordinatorAgentId: "agent:leader" as never,
  pollIntervalMs: 50,
});

const decision = await escalation.request({
  requestId,
  agentId: "agent:worker" as never,
  requestedGrants: ["fs:write"],
  purposeStatement: purpose,
  expiresAt: Date.now() + ttlMs,
});
process.stdout.write(`${JSON.stringify(decision)}\n`);
transport.close();
process.exit(0);
