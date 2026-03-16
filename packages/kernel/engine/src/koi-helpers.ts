/**
 * Top-level helpers used by createKoi() — extracted to keep koi.ts under 800 lines.
 *
 * Pure functions with no closure dependencies on the runtime.
 */

import type {
  AgentGroupId,
  ApprovalHandler,
  ChannelStatus,
  InboundMessage,
  ProcessId,
  SessionContext,
  TurnContext,
} from "@koi/core";
import { agentId, turnId } from "@koi/core";

/** Generate a unique process ID for a new agent. */
export function generatePid(
  manifest: { readonly name: string; readonly lifecycle?: "copilot" | "worker" | undefined },
  options?: {
    readonly parent?: ProcessId;
    readonly groupId?: AgentGroupId;
  },
): ProcessId {
  // Manifest lifecycle is the primary source of truth.
  // Fallback: worker if spawned (has parent), copilot if top-level.
  const agentType = manifest.lifecycle ?? (options?.parent !== undefined ? "worker" : "copilot");
  return {
    id: agentId(crypto.randomUUID()),
    name: manifest.name,
    type: agentType,
    depth: options?.parent !== undefined ? options.parent.depth + 1 : 0,
    ...(options?.parent !== undefined ? { parent: options.parent.id } : {}),
    ...(options?.groupId !== undefined ? { groupId: options.groupId } : {}),
  };
}

/** Call .unref() on a timer if available (Bun Timer). Prevents idle timer from keeping process alive. */
export function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  if (timer !== null && typeof timer === "object" && "unref" in timer) {
    (timer as { readonly unref: () => void }).unref();
  }
}

/** Factory for constructing TurnContext with hierarchical turnId. */
export function createTurnContext(opts: {
  readonly session: SessionContext;
  readonly turnIndex: number;
  readonly messages: readonly InboundMessage[];
  readonly signal?: AbortSignal | undefined;
  readonly approvalHandler?: ApprovalHandler | undefined;
  readonly sendStatus?: ((status: ChannelStatus) => Promise<void>) | undefined;
}): TurnContext {
  return {
    session: opts.session,
    turnIndex: opts.turnIndex,
    turnId: turnId(opts.session.runId, opts.turnIndex),
    messages: opts.messages,
    metadata: {},
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.approvalHandler !== undefined ? { requestApproval: opts.approvalHandler } : {}),
    ...(opts.sendStatus !== undefined ? { sendStatus: opts.sendStatus } : {}),
  };
}
