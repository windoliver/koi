/**
 * Agent status reporter — Nexus-inspired spec/status reporting.
 *
 * Periodically collects agent status from the host and sends
 * status frames to the Gateway via the transport.
 */

import { generateCorrelationId } from "../connection/protocol.js";
import type { AgentStatusPayload, NodeFrame } from "../types.js";
import type { AgentHost } from "./host.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StatusReporter {
  /** Start periodic status reporting. */
  readonly start: () => void;
  /** Stop reporting and clean up timers. */
  readonly stop: () => void;
  /** Collect status for all agents (on-demand). */
  readonly collect: () => readonly AgentStatusPayload[];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createStatusReporter(
  nodeId: string,
  host: AgentHost,
  sendFrame: (frame: NodeFrame) => void,
  intervalMs: number = 10_000,
): StatusReporter {
  let timer: ReturnType<typeof setInterval> | undefined;

  function collect(): readonly AgentStatusPayload[] {
    const statuses: AgentStatusPayload[] = [];
    for (const agent of host.agents()) {
      const agentMetrics = host.metrics(agent.pid.id);
      statuses.push({
        agentId: agent.pid.id,
        state: agent.state,
        turnCount: agentMetrics?.turnCount ?? 0,
        lastActivityMs: agentMetrics?.lastActivityMs ?? 0,
      });
    }
    return statuses;
  }

  function report(): void {
    const statuses = collect();
    if (statuses.length === 0) return;

    // Batch all agent statuses into a single frame to minimize WS overhead
    sendFrame({
      nodeId,
      agentId: "",
      correlationId: generateCorrelationId(nodeId),
      kind: "agent:status",
      payload: { agents: statuses },
    });
  }

  return {
    start() {
      if (timer !== undefined) return;
      timer = setInterval(report, intervalMs);
    },

    stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },

    collect,
  };
}
