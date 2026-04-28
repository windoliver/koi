/**
 * Smoke test: exercise the refactored @koi/nexus-delegation API against a
 * real running Nexus container.
 *
 *   bun run packages/security/nexus-delegation/scripts/smoke.ts
 *
 * Requires:
 *   NEXUS_URL              — defaults to http://localhost:40970
 *   NEXUS_PARENT_API_KEY   — an agent-typed API key (not the root admin key)
 */
import { createNexusDelegationApi } from "../src/index.js";

const NEXUS_URL = process.env.NEXUS_URL ?? "http://localhost:40970";
const PARENT_API_KEY = process.env.NEXUS_PARENT_API_KEY ?? "";

if (PARENT_API_KEY === "") {
  console.error("Set NEXUS_PARENT_API_KEY (an agent-typed API key, not a root admin key).");
  process.exit(2);
}

const api = createNexusDelegationApi({ url: NEXUS_URL, apiKey: PARENT_API_KEY });

const childId = `child-smoke-${Date.now()}`;
const result = await api.createDelegation({
  worker_id: childId,
  worker_name: childId,
  namespace_mode: "copy",
  ttl_seconds: 600,
  intent: "@koi/nexus-delegation refactor smoke test",
});

if (!result.ok) {
  console.error("FAIL:", result.error);
  process.exit(1);
}

console.log("OK — delegation created via real Nexus");
console.log("  delegation_id   :", result.value.delegation_id);
console.log("  worker_agent_id :", result.value.worker_agent_id);
console.log("  api_key prefix  :", `${result.value.api_key.slice(0, 16)}...`);
console.log("  mount_table     :", result.value.mount_table);
console.log("  delegation_mode :", result.value.delegation_mode);
console.log("  expires_at      :", result.value.expires_at);
console.log("  warmup_success  :", result.value.warmup_success);
