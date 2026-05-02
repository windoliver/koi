import type { AgentId, SessionId } from "@koi/core";

/**
 * Bounded view of one session for list/detail dashboards.
 * Cost is in USD; -1 means "unknown" (no pricing data yet).
 */
export interface SessionSummary {
  readonly sessionId: SessionId;
  readonly agentId: AgentId;
  readonly status: "active" | "completed" | "failed" | "cancelled";
  readonly turns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly startedAt: number;
  readonly endedAt?: number | undefined;
}
