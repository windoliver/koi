import type { AgentId, EngineInput } from "@koi/core";

// TaskDispatcher is NOT in @koi/core — defined here.
// signal aborted when timeoutMs elapses. Timeout is terminal: timed-out tasks
// go to dead_letter, NOT retried. Dispatchers SHOULD propagate signal;
// if they cannot, they MUST be idempotent (task ID is the idempotency key).
export type TaskDispatcher = (
  agentId: AgentId,
  input: EngineInput,
  mode: "spawn" | "dispatch",
  signal: AbortSignal,
) => Promise<void>;
