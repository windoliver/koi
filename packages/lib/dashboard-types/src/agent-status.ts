import type { AgentId, ProcessState } from "@koi/core";

/**
 * Snapshot of one agent's runtime state at a point in time.
 *
 * Server projects this from `@koi/agent-procfs`/registry. Stable shape:
 * dashboards rendering this struct must not depend on field order.
 */
export interface AgentStatus {
  readonly agentId: AgentId;
  readonly name: string;
  readonly state: ProcessState;
  /**
   * Known v1 values are `"copilot"` and `"worker"`. The string-escape hatch
   * keeps callers IntelliSense-aware of the well-known values while staying
   * forward-compatible with newer servers that may emit additional kinds.
   */
  readonly agentType: "copilot" | "worker" | (string & {});
  readonly model?: string | undefined;
  readonly channels: readonly string[];
  readonly turns: number;
  readonly tokenCount: number;
  readonly startedAt: number;
  readonly lastActivityAt: number;
  readonly parentId?: AgentId | undefined;
  readonly childCount: number;
}
