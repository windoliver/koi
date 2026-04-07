/**
 * MCP lifecycle recorder — records MCP transport state transitions
 * as system steps in the ATIF trajectory.
 */

import type { JsonObject, RichTrajectoryStep, TrajectoryDocumentStore } from "@koi/core";
import type { TransportStateMachine } from "@koi/mcp";

export interface McpLifecycleConfig {
  readonly stateMachine: TransportStateMachine;
  readonly store: TrajectoryDocumentStore;
  readonly docId: string;
  readonly serverName: string;
  /** Injectable clock for deterministic timestamps. Default: Date.now. */
  readonly clock?: () => number;
}

export function recordMcpLifecycle(config: McpLifecycleConfig): () => void {
  const { stateMachine, store, docId, serverName } = config;
  const clock = config.clock ?? Date.now;

  return stateMachine.onChange((state) => {
    const step: RichTrajectoryStep = {
      stepIndex: 0, // Corrected by store's global counter
      timestamp: clock(),
      source: "system",
      kind: "model_call", // Maps to message/model_name in ATIF (not tool_calls)
      identifier: `mcp:${serverName}`,
      outcome: state.kind === "error" ? "failure" : "success",
      durationMs: 0,
      request: { text: `MCP transport: ${state.kind}` },
      metadata: {
        type: "mcp_lifecycle",
        serverName,
        transportState: state.kind,
        ...(state.kind === "connecting" ? { attempt: state.attempt } : {}),
      } as JsonObject,
    };

    void store.append(docId, [step]).catch(() => {});
  });
}
