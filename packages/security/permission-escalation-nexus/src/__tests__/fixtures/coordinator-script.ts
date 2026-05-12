/**
 * Layer-2 coordinator fixture. Spawned as a child process by two-process.test.ts.
 * Polls the daemon and resolves every escalation request based on the env-configured
 * verdict. Prints "ready" once polling has started so the test can sequence safely.
 */
import { createHttpTransport } from "@koi/nexus-client";
import { createNexusPermissionEscalationCoordinator } from "../../nexus-permission-escalation-coordinator.js";

const url = process.env.NEXUS_URL;
const verdict = process.env.VERDICT ?? "approve";
if (url === undefined) {
  console.error("missing NEXUS_URL");
  process.exit(2);
}

const transport = createHttpTransport({ url });
const coord = createNexusPermissionEscalationCoordinator({
  transport,
  coordinatorAgentId: "agent:leader" as never,
});

let stopped = false;
process.on("SIGTERM", () => {
  stopped = true;
});

const resolver = async (req: { readonly requestedGrants: readonly string[] }) => {
  if (verdict === "approve") {
    return { decision: "approved" as const, grantedGrants: [...req.requestedGrants] };
  }
  return { decision: "rejected" as const, reason: `coordinator denied (${verdict})` };
};

process.stdout.write("ready\n");
while (!stopped) {
  await coord.pollOnce(resolver);
  await Bun.sleep(25);
}
transport.close();
process.exit(0);
