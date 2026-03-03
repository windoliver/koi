/**
 * Delegation-escalation middleware factory.
 *
 * Monitors delegatee circuit breakers via a callback and, when all are
 * exhausted, pauses the engine loop by awaiting a human response through
 * the channel. On "resume", injects the human's instruction as a system
 * message. On "abort", throws to halt the engine.
 */

import type {
  CapabilityFragment,
  DelegationEvent,
  InboundMessage,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  TurnContext,
} from "@koi/core";
import type { EscalationGate } from "./escalation-gate.js";
import { createEscalationGate } from "./escalation-gate.js";
import { generateEscalationMessage } from "./escalation-message.js";
import type {
  DelegationEscalationConfig,
  DelegationEscalationHandle,
  EscalationContext,
  EscalationDecision,
} from "./types.js";
import { DEFAULT_ESCALATION_TIMEOUT_MS } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIDDLEWARE_NAME = "koi:delegation-escalation";

/** Priority 300: runs before semantic-retry (420). Lower = outer layer. */
const MIDDLEWARE_PRIORITY = 300;

const ESCALATION_SENDER_ID = "human-escalation";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDelegationEscalationMiddleware(
  config: DelegationEscalationConfig,
): DelegationEscalationHandle {
  const {
    channel,
    isExhausted,
    issuerId,
    monitoredDelegateeIds,
    taskSummary,
    onEscalation,
    onExhausted,
  } = config;
  const timeoutMs = config.escalationTimeoutMs ?? DEFAULT_ESCALATION_TIMEOUT_MS;

  // let: mutable — gate is created on exhaustion and cleared on resolution
  let gate: EscalationGate | undefined;

  function emitExhaustedEvent(): void {
    if (onExhausted === undefined) return;

    const event: DelegationEvent = {
      kind: "delegation:exhausted",
      delegateeIds: monitoredDelegateeIds,
      issuerId,
      detectedAt: Date.now(),
    };
    onExhausted(event);
  }

  async function armEscalation(signal?: AbortSignal): Promise<void> {
    // Double-arm prevention: don't create a second gate if one is pending
    if (gate?.isPending()) return;

    emitExhaustedEvent();

    const ctx: EscalationContext = {
      issuerId,
      exhaustedDelegateeIds: monitoredDelegateeIds,
      detectedAt: Date.now(),
      taskSummary,
    };

    const message = generateEscalationMessage(ctx);
    await channel.send(message);

    gate = createEscalationGate(channel, signal, timeoutMs);
  }

  async function awaitDecision(): Promise<EscalationDecision> {
    if (gate === undefined) {
      return { kind: "resume" };
    }

    const decision = await gate.promise;
    onEscalation?.(decision);
    gate = undefined;
    return decision;
  }

  function injectInstruction(request: ModelRequest, instruction: string): ModelRequest {
    const systemMessage: InboundMessage = {
      content: [{ kind: "text", text: `[Human escalation instruction] ${instruction}` }],
      senderId: ESCALATION_SENDER_ID,
      timestamp: Date.now(),
    };
    return {
      ...request,
      messages: [...request.messages, systemMessage],
    };
  }

  const middleware: KoiMiddleware = {
    name: MIDDLEWARE_NAME,
    priority: MIDDLEWARE_PRIORITY,

    async onAfterTurn(ctx: TurnContext): Promise<void> {
      if (!isExhausted()) return;
      if (gate?.isPending()) return;

      await armEscalation(ctx.signal);
    },

    async wrapModelCall(
      _ctx: TurnContext,
      request: ModelRequest,
      next: (request: ModelRequest) => Promise<ModelResponse>,
    ): Promise<ModelResponse> {
      // If no gate is pending, pass through
      if (gate === undefined || !gate.isPending()) {
        return next(request);
      }

      // Await the human decision
      const decision = await awaitDecision();

      if (decision.kind === "abort") {
        throw new Error(`Delegation escalation aborted: ${decision.reason}`);
      }

      // Resume — optionally inject human instruction
      const finalRequest =
        decision.instruction !== undefined
          ? injectInstruction(request, decision.instruction)
          : request;

      return next(finalRequest);
    },

    describeCapabilities(_ctx: TurnContext): CapabilityFragment {
      const isPending = gate?.isPending();
      return {
        label: "delegation-escalation",
        description: isPending
          ? "Delegation escalation: awaiting human response"
          : `Delegation escalation: monitoring ${String(monitoredDelegateeIds.length)} delegatees`,
      };
    },
  };

  return {
    middleware,
    isPending: () => gate?.isPending() ?? false,
    cancel: () => gate?.cancel(),
  };
}
