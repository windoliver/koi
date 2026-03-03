/**
 * Correlation IDs — hierarchical identity for tracing and telemetry.
 *
 * sessionId → runId → turnId → toolCallId
 */

import type { RunId, SessionId, ToolCallId, TurnId } from "./ecs.js";

export interface CorrelationIds {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly turnId?: TurnId | undefined;
  readonly toolCallId?: ToolCallId | undefined;
}
