// Helper for the cross-process concurrency regression test in
// jsonl-store.test.ts. Spawned twice via Bun.spawn — must live inside
// the package src dir so `@koi/governance-approval-tiers`/`@koi/core`
// imports resolve through the workspace `node_modules`.

import { agentId as mkAgentId } from "@koi/core";
import { createJsonlApprovalStore } from "../jsonl-store.js";

const [path, label, countStr] = process.argv.slice(2);
if (path === undefined || label === undefined || countStr === undefined) {
  throw new Error("usage: concurrent-runner <path> <label> <count>");
}
const count = Number(countStr);
const store = createJsonlApprovalStore({ path });

await Promise.all(
  Array.from({ length: count }, (_, i) =>
    store.append({
      kind: "tool_call",
      agentId: mkAgentId("race"),
      payload: { tool: "bash", n: i, w: label },
      grantKey: `${label}-${i}`,
      grantedAt: i,
    }),
  ),
);
