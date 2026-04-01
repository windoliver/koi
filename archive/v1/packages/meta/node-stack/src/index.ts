/**
 * @koi/node-stack — Full node bundle (Layer 3)
 *
 * Convenience package that wires @koi/node + @koi/agent-discovery +
 * @koi/agent-procfs + @koi/debug + @koi/tracing into a single
 * createNodeStack() call.
 *
 * Usage:
 *   const stack = createNodeStack(
 *     { node: nodeConfig, tracing: {}, discovery: {} },
 *     { registry },
 *   );
 *   await stack.start();
 */

// -- Re-exports from @koi/agent-discovery -----------------------------------
export type { DiscoveryProviderConfig } from "@koi/agent-discovery";
export { createDiscoveryProvider } from "@koi/agent-discovery";
// -- Re-exports from @koi/agent-procfs -------------------------------------
export type { AgentMounterConfig, ProcFsConfig } from "@koi/agent-procfs";
export { createAgentMounter, createProcFs } from "@koi/agent-procfs";
// -- Re-exports from @koi/debug ---------------------------------------------
export type { DebugAttachConfig, DebugAttachResult } from "@koi/debug";
export {
  clearAllDebugSessions,
  createDebugAttach,
  createDebugObserve,
  hasDebugSession,
} from "@koi/debug";
// -- Re-exports from @koi/node ----------------------------------------------
export type {
  FullKoiNode,
  KoiNode,
  NodeDeps,
  ThinKoiNode,
} from "@koi/node";
// -- Re-exports from @koi/tracing -------------------------------------------
export type { TracingConfig } from "@koi/tracing";
export { createTracedFetch, createTracingMiddleware } from "@koi/tracing";
// -- Own exports ------------------------------------------------------------
export { createNodeStack } from "./create-node-stack.js";
export type { NodeStack, NodeStackConfig, NodeStackDeps } from "./types.js";
