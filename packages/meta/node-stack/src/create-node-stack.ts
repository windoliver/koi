/**
 * Full node stack factory — wires core node, agent-discovery, agent-procfs,
 * and tracing into a single start/stop lifecycle.
 */

import { createDiscoveryProvider } from "@koi/agent-discovery";
import type { AgentMounter } from "@koi/agent-procfs";
import { createAgentMounter, createProcFs } from "@koi/agent-procfs";
import { createNode } from "@koi/node";
import { createTracingMiddleware } from "@koi/tracing";
import type { NodeStack, NodeStackConfig, NodeStackDeps } from "./types.js";

export function createNodeStack(config: NodeStackConfig, deps?: NodeStackDeps): NodeStack {
  const nodeResult = createNode(config.node, deps);
  if (!nodeResult.ok) {
    throw new Error(`Invalid node config: ${nodeResult.error.message}`);
  }
  const node = nodeResult.value;

  const discoveryProvider =
    config.discovery !== undefined ? createDiscoveryProvider(config.discovery) : undefined;

  const procFs = config.procfs !== undefined ? createProcFs(config.procfs) : undefined;

  // let: conditionally assigned based on procfs + registry + full-mode check
  let agentMounter: AgentMounter | undefined;
  if (procFs !== undefined && deps?.registry !== undefined && node.mode === "full") {
    agentMounter = createAgentMounter({
      registry: deps.registry,
      procFs,
      agentProvider: node.getAgent,
    });
  }

  const tracingMiddleware =
    config.tracing !== undefined ? createTracingMiddleware(config.tracing) : undefined;

  return {
    node,
    discoveryProvider,
    tracingMiddleware,
    procFs,

    async start(): Promise<void> {
      await node.start();
    },

    async stop(): Promise<void> {
      agentMounter?.dispose();
      await node.stop();
    },
  };
}
